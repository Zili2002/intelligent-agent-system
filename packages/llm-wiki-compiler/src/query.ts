import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { LlmUsageTracker, requireLlm, requestJson } from "./llm.js";
import {
  configuredEmbeddingProvider,
  loadSemanticIndex,
  semanticContentHash,
  semanticSimilarity,
} from "./semantic-index.js";
import type {
  ContradictionAdjudication,
  EvidenceStatus,
  QueryMatch,
  QueryResult,
  ServiceOptions,
} from "./types.js";

interface RegistryLocator {
  chunkId?: string;
  chunkIndex?: number;
  section?: string;
  start?: number;
  end?: number;
  page?: number;
}

export interface RegistryClaim {
  id: string;
  sourceId: string;
  quote: string;
  text?: string;
  statement?: string;
  locator?: RegistryLocator;
  sourceTitle?: string;
  sourcePath?: string;
  source?: { title?: string; path?: string };
  topicIds?: string[];
  status?: string;
  confidence?: number;
  evidenceStatus?: EvidenceStatus;
  lifecycleStatus?:
    | "active"
    | "version-review-required"
    | "retracted-source"
    | "superseded-source";
}

interface ClaimRegistry {
  claims?: RegistryClaim[];
  sources?: Array<{ id: string; title?: string; path?: string }>;
}

interface ClaimEdge {
  from: string;
  to: string;
  type: "supports" | "contradicts" | "qualifies" | "duplicate";
  explanation: string;
}

export interface RankedClaim {
  claim: RegistryClaim;
  score: number;
  lexicalScore: number;
  semanticScore: number;
  graphScore: number;
}

export interface RetrievalResult {
  candidates: RankedClaim[];
  mode: "lexical" | "hybrid";
  registry: ClaimRegistry;
  contradictions: Array<{
    from: string;
    to: string;
    explanation: string;
    adjudication?: ContradictionAdjudication;
  }>;
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "does",
  "for",
  "from",
  "have",
  "how",
  "into",
  "its",
  "the",
  "their",
  "this",
  "that",
  "what",
  "when",
  "which",
  "with",
]);

function tokens(value: string): string[] {
  return [
    ...new Set(
      value
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu)
        ?.filter((token) => !STOP_WORDS.has(token)) ?? [],
    ),
  ];
}

function claimText(claim: RegistryClaim): string {
  return claim.statement ?? claim.text ?? "";
}

function acceptedClaims(registry: ClaimRegistry): RegistryClaim[] {
  if (!Array.isArray(registry.claims)) return [];
  return registry.claims.filter(
    (claim) =>
      claim &&
      typeof claim.id === "string" &&
      typeof claim.sourceId === "string" &&
      typeof claim.quote === "string" &&
      claim.quote.trim() &&
      claim.status !== "rejected",
  );
}

function scoreClaim(claim: RegistryClaim, questionTokens: string[]): number {
  const text =
    `${claimText(claim)} ${claim.quote} ${claim.sourceTitle ?? claim.source?.title ?? ""} ${claim.status === "accepted" ? "supported" : ""}`.toLocaleLowerCase();
  return questionTokens.reduce((score, token) => {
    if (!text.includes(token)) return score;
    return (
      score + (claimText(claim).toLocaleLowerCase().includes(token) ? 3 : 1)
    );
  }, 0);
}

async function optionalJson(
  file: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Artifact must be an object: ${file}`);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function claimEdges(value: Record<string, unknown> | undefined): ClaimEdge[] {
  if (!value) return [];
  if (!Array.isArray(value.edges)) {
    throw new Error("Claim graph edges must be an array");
  }
  return value.edges.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Claim graph edge ${index} must be an object`);
    }
    const edge = item as Record<string, unknown>;
    if (
      typeof edge.from !== "string" ||
      typeof edge.to !== "string" ||
      !["supports", "contradicts", "qualifies", "duplicate"].includes(
        edge.type as string,
      ) ||
      typeof edge.explanation !== "string"
    ) {
      throw new Error(`Claim graph edge ${index} is invalid`);
    }
    return {
      from: edge.from,
      to: edge.to,
      type: edge.type as ClaimEdge["type"],
      explanation: edge.explanation,
    };
  });
}

function adjudications(
  value: Record<string, unknown> | undefined,
): ContradictionAdjudication[] {
  if (!value) return [];
  if (!Array.isArray(value.adjudications)) {
    throw new Error("Contradiction adjudications must be an array");
  }
  return value.adjudications as ContradictionAdjudication[];
}

export async function retrieveClaims(
  question: string,
  options: ServiceOptions = {},
): Promise<RetrievalResult> {
  if (!question.trim()) throw new Error("Question must not be empty");
  const config = await loadConfig(options.root);
  let registry: ClaimRegistry;
  try {
    registry = JSON.parse(
      await readFile(path.join(config.metaDir, "claims.json"), "utf8"),
    ) as ClaimRegistry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("No compiled claim registry found. Run compile first.");
    }
    throw new Error(
      `Compiled Claim Registry is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const claims = acceptedClaims(registry);
  const questionTokens = tokens(question);
  const lexical = new Map(
    claims.map((claim) => [claim.id, scoreClaim(claim, questionTokens)]),
  );
  const maxLexical = Math.max(0, ...lexical.values());
  const [index, graphData, adjudicationData, lifecycleData] = await Promise.all(
    [
      loadSemanticIndex(
        config.metaDir,
        options.semanticIndexPath ??
          path.join(config.metaDir, "semantic_index.json"),
      ),
      optionalJson(path.join(config.metaDir, "claim_graph.json")),
      optionalJson(
        path.join(config.metaDir, "contradiction_adjudications.json"),
      ),
      optionalJson(path.join(config.metaDir, "knowledge_lifecycle.json")),
    ],
  );
  const lifecycleByClaim = new Map<string, RegistryClaim["lifecycleStatus"]>();
  if (lifecycleData) {
    if (!Array.isArray(lifecycleData.claims)) {
      throw new Error("Knowledge lifecycle claims must be an array");
    }
    for (const item of lifecycleData.claims) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Knowledge lifecycle Claim entry is invalid");
      }
      const entry = item as Record<string, unknown>;
      if (
        typeof entry.claimId !== "string" ||
        (entry.status !== "active" &&
          entry.status !== "version-review-required" &&
          entry.status !== "retracted-source" &&
          entry.status !== "superseded-source")
      ) {
        throw new Error("Knowledge lifecycle Claim status is invalid");
      }
      lifecycleByClaim.set(entry.claimId, entry.status);
    }
  }
  for (const claim of claims) {
    const lifecycleStatus = lifecycleByClaim.get(claim.id);
    if (lifecycleStatus) claim.lifecycleStatus = lifecycleStatus;
  }
  const asksAboutLifecycle =
    /\b(retract(?:ed|ion)?|withdrawn|withdrawal|supersed(?:e|ed|ing)|version|historical)\b/i.test(
      question,
    );
  const edges = claimEdges(graphData);
  const semantic = new Map<string, number>();
  let mode: RetrievalResult["mode"] = "lexical";
  if (index) {
    const provider =
      options.embeddingProvider ?? configuredEmbeddingProvider(config);
    if (
      provider.model !== index.model ||
      (provider.configurationId ?? provider.model) !==
        (index.configurationId ?? index.model)
    ) {
      throw new Error(
        `Embedding provider ${provider.configurationId ?? provider.model} does not match semantic index ${index.configurationId ?? index.model}`,
      );
    }
    const vectors = await provider.embed([question], "query");
    const queryVector = vectors[0];
    if (
      !queryVector ||
      queryVector.length !== index.dimensions ||
      queryVector.some((value) => !Number.isFinite(value))
    ) {
      throw new Error("Embedding provider returned an invalid query vector");
    }
    const currentHashes = new Map(
      claims.map((claim) => [
        claim.id,
        semanticContentHash(
          {
            id: claim.id,
            statement: claimText(claim),
            quote: claim.quote,
            sourceTitle: claim.sourceTitle ?? claim.source?.title ?? "",
            topicIds: claim.topicIds ?? [],
          },
          index.passagePrefix ?? "",
        ),
      ]),
    );
    for (const entry of index.claims) {
      if (currentHashes.get(entry.claimId) !== entry.contentHash) continue;
      semantic.set(
        entry.claimId,
        Math.max(0, semanticSimilarity(queryVector, entry.vector)),
      );
    }
    mode = "hybrid";
  }
  const initial = claims
    .filter(
      (claim) =>
        (claim.lifecycleStatus !== "retracted-source" &&
          claim.lifecycleStatus !== "superseded-source") ||
        asksAboutLifecycle,
    )
    .map((claim) => {
      const lexicalScore = maxLexical
        ? (lexical.get(claim.id) ?? 0) / maxLexical
        : 0;
      const semanticScore = semantic.get(claim.id) ?? 0;
      const lifecycleMultiplier =
        claim.lifecycleStatus === "version-review-required"
          ? 0.5
          : claim.lifecycleStatus === "retracted-source"
            ? 0
            : claim.lifecycleStatus === "superseded-source"
              ? 0
              : 1;
      const confidenceScore =
        ((claim.confidence ?? 0) / 100) * lifecycleMultiplier;
      return {
        claim,
        lexicalScore,
        semanticScore,
        confidenceScore,
        base:
          config.retrieval.lexicalWeight * lexicalScore +
          config.retrieval.semanticWeight * semanticScore +
          config.retrieval.confidenceWeight * confidenceScore,
      };
    });
  const lexicalIds = initial
    .filter((item) => item.lexicalScore > 0)
    .sort((left, right) => right.lexicalScore - left.lexicalScore)
    .slice(0, config.retrieval.semanticCandidateLimit)
    .map((item) => item.claim.id);
  const semanticIds = initial
    .filter((item) => item.semanticScore > 0)
    .sort((left, right) => right.semanticScore - left.semanticScore)
    .slice(0, config.retrieval.semanticCandidateLimit)
    .map((item) => item.claim.id);
  const candidateIds = new Set([...lexicalIds, ...semanticIds]);
  const seeds = new Set(
    initial
      .filter((item) => candidateIds.has(item.claim.id))
      .sort((left, right) => right.base - left.base)
      .slice(0, 10)
      .map((item) => item.claim.id),
  );
  const seedScores = new Map(
    initial
      .filter((item) => seeds.has(item.claim.id))
      .map((item) => [item.claim.id, item.base]),
  );
  const graphScores = new Map<string, number>();
  const contradictionPairScores = new Map<string, number>();
  for (const edge of edges) {
    const weight =
      edge.type === "supports" ||
      edge.type === "duplicate" ||
      edge.type === "contradicts"
        ? 1
        : edge.type === "qualifies"
          ? 0.7
          : 0;
    if (seeds.has(edge.from)) {
      graphScores.set(edge.to, Math.max(graphScores.get(edge.to) ?? 0, weight));
      candidateIds.add(edge.to);
      if (edge.type === "contradicts") {
        contradictionPairScores.set(
          edge.to,
          Math.max(
            contradictionPairScores.get(edge.to) ?? 0,
            (seedScores.get(edge.from) ?? 0) - 0.001,
          ),
        );
      }
    }
    if (seeds.has(edge.to)) {
      graphScores.set(
        edge.from,
        Math.max(graphScores.get(edge.from) ?? 0, weight),
      );
      candidateIds.add(edge.from);
      if (edge.type === "contradicts") {
        contradictionPairScores.set(
          edge.from,
          Math.max(
            contradictionPairScores.get(edge.from) ?? 0,
            (seedScores.get(edge.to) ?? 0) - 0.001,
          ),
        );
      }
    }
  }
  const ranked = initial
    .filter((item) => candidateIds.has(item.claim.id))
    .map((item): RankedClaim => {
      const graphScore = graphScores.get(item.claim.id) ?? 0;
      return {
        claim: item.claim,
        lexicalScore: item.lexicalScore,
        semanticScore: item.semanticScore,
        graphScore,
        score: Math.max(
          item.base + config.retrieval.graphWeight * graphScore,
          contradictionPairScores.get(item.claim.id) ?? 0,
        ),
      };
    })
    .filter(
      (item) =>
        item.lexicalScore > 0 ||
        item.semanticScore >= 0.15 ||
        item.graphScore > 0 ||
        item.score >= 0.18,
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        (right.claim.confidence ?? 0) - (left.claim.confidence ?? 0) ||
        left.claim.id.localeCompare(right.claim.id),
    )
    .slice(0, config.llm.queryCandidateLimit);
  const rankedIds = new Set(ranked.map((item) => item.claim.id));
  const adjudicationByEdge = new Map(
    adjudications(adjudicationData).flatMap((item) => [
      [`${item.from}\u0000${item.to}`, item] as const,
      [`${item.to}\u0000${item.from}`, item] as const,
    ]),
  );
  const contradictions = edges
    .filter(
      (edge) =>
        edge.type === "contradicts" &&
        rankedIds.has(edge.from) &&
        rankedIds.has(edge.to),
    )
    .map((edge) => {
      const adjudication = adjudicationByEdge.get(
        `${edge.from}\u0000${edge.to}`,
      );
      return {
        from: edge.from,
        to: edge.to,
        explanation: edge.explanation,
        ...(adjudication ? { adjudication } : {}),
      };
    });
  return { candidates: ranked, mode, registry, contradictions };
}

function matchFor(
  claim: RegistryClaim,
  sources: ClaimRegistry["sources"],
  score: number,
): QueryMatch {
  const source = sources?.find((item) => item.id === claim.sourceId);
  const title =
    claim.sourceTitle ??
    claim.source?.title ??
    source?.title ??
    `Source ${claim.sourceId}`;
  const sourcePath = claim.sourcePath ?? claim.source?.path ?? source?.path;
  const locator = claim.locator;
  const locatorText = [
    locator?.section ? `section ${locator.section}` : undefined,
    locator?.page === undefined ? undefined : `page ${locator.page}`,
    locator?.start === undefined ? undefined : `offset ${locator.start}`,
  ]
    .filter(Boolean)
    .join(", ");
  return {
    path: sourcePath ?? `sources/${claim.sourceId}.md`,
    title,
    score,
    excerpt: locatorText ? `${claim.quote} (${locatorText})` : claim.quote,
    ...(claim.confidence !== undefined ? { confidence: claim.confidence } : {}),
    ...(claim.evidenceStatus ? { evidenceStatus: claim.evidenceStatus } : {}),
  };
}

export async function queryWiki(
  question: string,
  options: ServiceOptions & { limit?: number } = {},
): Promise<QueryResult> {
  if (!question.trim()) throw new Error("Question must not be empty");
  const limit = options.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Query limit must be an integer from 1 to 100");
  const config = await loadConfig(options.root);
  const retrieval = await retrieveClaims(question, options);
  const { candidates, registry } = retrieval;
  if (!candidates.length) {
    return {
      question,
      answer: "Evidence is insufficient to answer this question.",
      citations: [],
      matches: [],
    };
  }

  const provider = requireLlm(config, options);
  const usage = new LlmUsageTracker(options.maxLlmTokens);
  const candidateIds = new Set(candidates.map(({ claim }) => claim.id));
  const output = await requestJson(
    provider,
    {
      purpose: "query",
      maxTokens: config.llm.queryOutputTokens,
      prompt: `Rerank and answer the question using only these immutable evidence claims. Return JSON {answer:string,citations:string[]}. If evidence is weak, irrelevant, or insufficient, say so and return no citations. Citations must be stable Registry Claim IDs from the supplied candidates, and every material factual assertion must be supported by a citation. Never use a retracted-source or superseded-source Claim as affirmative evidence. Treat version-review-required Claims as provisional. Explicitly describe relevant conflicts using the supplied contradiction adjudications; do not collapse context-dependent evidence into a single verdict. Do not rewrite evidence metadata.\nQuestion: ${question}\nRetrieval mode: ${retrieval.mode}\nCandidates: ${JSON.stringify(candidates.map(({ claim, score, lexicalScore, semanticScore, graphScore }) => ({ id: claim.id, statement: claimText(claim), quote: claim.quote, sourceId: claim.sourceId, locator: claim.locator, confidence: claim.confidence, evidenceStatus: claim.evidenceStatus, lifecycleStatus: claim.lifecycleStatus, hybridScore: score, lexicalScore, semanticScore, graphScore })))}\nContradictions: ${JSON.stringify(retrieval.contradictions)}`,
    },
    (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("query must be an object");
      const data = value as Record<string, unknown>;
      if (typeof data.answer !== "string" || !data.answer.trim())
        throw new Error("query answer must be a non-empty string");
      if (
        !Array.isArray(data.citations) ||
        data.citations.some((id) => typeof id !== "string")
      )
        throw new Error("query citations must be strings");
      if ((data.citations as string[]).some((id) => !candidateIds.has(id)))
        throw new Error("query cited an unknown claim ID");
      return {
        answer: data.answer.trim(),
        citations: [...new Set(data.citations as string[])],
      };
    },
    usage,
  );
  const byId = new Map(candidates.map((item) => [item.claim.id, item]));
  const citations = new Set(output.citations);
  for (const contradiction of retrieval.contradictions) {
    if (citations.has(contradiction.from) || citations.has(contradiction.to)) {
      citations.add(contradiction.from);
      citations.add(contradiction.to);
    }
  }
  return {
    question,
    answer: output.answer,
    citations: [...citations],
    matches: [...citations].slice(0, limit).map((claimId) => {
      const item = byId.get(claimId);
      if (!item) throw new Error("query cited an unavailable claim ID");
      return {
        ...matchFor(
          item.claim,
          registry.sources,
          Math.round(item.score * 1_000),
        ),
        lexicalScore: item.lexicalScore,
        semanticScore: item.semanticScore,
        graphScore: item.graphScore,
      };
    }),
    retrievalMode: retrieval.mode,
    retrievedClaimIds: candidates.map((item) => item.claim.id),
    usage: usage.result(),
  };
}
