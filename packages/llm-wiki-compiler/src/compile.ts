import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { loadContradictionAdjudications } from "./adjudicate.js";
import {
  cleanModel,
  LlmUsageTracker,
  requireLlm,
  requestJson,
  WikiLlmResponseError,
} from "./llm.js";
import {
  buildQualityArtifacts,
  writeQualityPages,
  type ClaimConfidence,
} from "./quality.js";
import {
  configuredEmbeddingProvider,
  loadSemanticIndex,
  semanticSimilarity,
} from "./semantic-index.js";
import type {
  CompileResult,
  EmbeddingProvider,
  ServiceOptions,
  SourceArtifact,
} from "./types.js";
import {
  generatedDocument,
  mapConcurrent,
  readTextIfExists,
  relativePosix,
  sha256,
  slugify,
  walkFiles,
  writeText,
} from "./utils.js";

const SOURCE_PROMPT_VERSION = "knowledge-v4-chunks";
const SYNTHESIS_PROMPT_VERSION = "synthesis-v4-compact-sampling";
const TOPIC_PROMPT_VERSION = "topic-v1-evidence-immutable";
const RELATIONSHIP_PROMPT_VERSION = "relationships-v3-short-explanations";

interface AnalysisClaim {
  id: string;
  text: string;
  quote: string;
  locator: EvidenceLocator;
}
interface AnalysisConcept {
  id: string;
  title: string;
  definition: string;
  claimIds: string[];
}
interface SourceAnalysis {
  relevant: boolean;
  exclusionReason: string;
  summary: string;
  concepts: AnalysisConcept[];
  claims: AnalysisClaim[];
  rejectedClaims: string[];
}
interface EvidenceLocator {
  sourceId: string;
  chunkId: string;
  chunkIndex: number;
  section?: string;
  start: number;
  end: number;
  page?: number;
}
export interface SourceChunk {
  id: string;
  hash: string;
  index: number;
  start: number;
  end: number;
  content: string;
  section?: string;
  page?: number;
}
interface SynthesisClaim {
  id: string;
  sourceId: string;
  quote: string;
  text: string;
  conceptIds: string[];
  locator: EvidenceLocator;
}
interface Synthesis {
  concepts: Array<{
    id: string;
    title: string;
    definition: string;
    claimIds: string[];
  }>;
  claims: SynthesisClaim[];
  contradictions: Array<{ claimIds: string[]; description: string }>;
  gaps: Array<{ priority: number; description: string; searchQuery: string }>;
}

async function artifacts(dir: string): Promise<SourceArtifact[]> {
  const result: SourceArtifact[] = [];
  for (const file of await walkFiles(dir, ".json")) {
    const value = JSON.parse(
      await readFile(file, "utf8"),
    ) as Partial<SourceArtifact>;
    if (
      value.version !== 1 ||
      typeof value.id !== "string" ||
      value.id !== value.hash ||
      !/^[a-f0-9]{64}$/.test(value.hash ?? "") ||
      typeof value.content !== "string" ||
      !value.content.trim() ||
      typeof value.title !== "string" ||
      typeof value.mediaType !== "string" ||
      typeof value.ingestedAt !== "string" ||
      !value.provenance ||
      !Array.isArray(value.provenanceHistory) ||
      value.provenanceHistory.some(
        (entry) =>
          !entry ||
          typeof entry !== "object" ||
          typeof entry.kind !== "string" ||
          typeof entry.input !== "string",
      )
    ) {
      throw new Error(`Malformed source artifact: ${file}`);
    }

    result.push(value as SourceArtifact);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

function sectionAt(content: string, offset: number): string | undefined {
  const headings = [
    ...content.slice(0, offset + 1).matchAll(/^#{1,6}\s+(.+?)\s*$/gm),
  ];
  return headings.at(-1)?.[1]?.trim();
}

function pageAt(source: SourceArtifact, start: number): number | undefined {
  return source.pageLocators?.find(
    (locator) => start >= locator.start && start < locator.end,
  )?.page;
}

/** Create reproducible, bounded overlapping chunks over normalized source text. */
export function chunkSource(
  source: SourceArtifact,
  config: {
    chunkInputChars: number;
    chunkOverlapChars: number;
    maxChunksPerSource: number;
    adaptiveChunkThresholdChars?: number;
    adaptiveChunkInputChars?: number;
  },
): SourceChunk[] {
  const limit =
    config.adaptiveChunkThresholdChars !== undefined &&
    config.adaptiveChunkInputChars !== undefined &&
    source.content.length >= config.adaptiveChunkThresholdChars
      ? config.adaptiveChunkInputChars
      : config.chunkInputChars;
  const overlap = config.chunkOverlapChars;
  const boundaries = new Set<number>([0, source.content.length]);
  for (const match of source.content.matchAll(/\n\n+/g))
    boundaries.add((match.index ?? 0) + match[0].length);
  for (const match of source.content.matchAll(/^#{1,6}\s+/gm))
    boundaries.add(match.index ?? 0);
  const points = [...boundaries].sort((a, b) => a - b);
  const chunks: SourceChunk[] = [];
  let start = 0;
  while (start < source.content.length) {
    const hardEnd = Math.min(source.content.length, start + limit);
    const end =
      points.filter((point) => point > start && point <= hardEnd).at(-1) ??
      hardEnd;
    const content = source.content.slice(start, end);
    const index = chunks.length;
    const section = sectionAt(source.content, start);
    const page = pageAt(source, start);
    const hash = sha256(content);
    chunks.push({
      id: sha256(
        JSON.stringify({
          sourceId: source.id,
          index,
          start,
          end,
          hash,
          section,
          page,
        }),
      ),
      hash,
      index,
      start,
      end,
      content,
      ...(section ? { section } : {}),
      ...(page === undefined ? {} : { page }),
    });
    if (chunks.length > config.maxChunksPerSource) {
      throw new Error(
        `Source ${source.id} requires more than llm.maxChunksPerSource (${config.maxChunksPerSource}) chunks; no LLM calls were made.`,
      );
    }
    if (end === source.content.length) break;
    const target = Math.max(start + 1, end - overlap);
    start = points.find((point) => point >= target && point < end) ?? target;
  }
  return chunks;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 8_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}
function strings(value: unknown, label: string, max = 50): string[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some((item) => typeof item !== "string" || !item.trim())
  )
    throw new Error(`${label} must be an array of strings`);
  return value.map((item) => item.trim());
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`${label} contains duplicate IDs`);
}

export function resolveExactQuote(
  content: string,
  requested: string,
): { quote: string; offset: number } | undefined {
  const exactOffset = content.indexOf(requested);
  if (exactOffset >= 0) return { quote: requested, offset: exactOffset };

  const normalizedMatch = (
    dehyphenate: boolean,
  ): { quote: string; offset: number } | undefined => {
    const chars: string[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    let index = 0;
    while (index < content.length) {
      if (
        dehyphenate &&
        content[index] === "-" &&
        index > 0 &&
        /\p{Letter}/u.test(content[index - 1]!)
      ) {
        let next = index + 1;
        while (next < content.length && /\s/.test(content[next]!)) next++;
        if (
          next > index + 1 &&
          next < content.length &&
          /\p{Letter}/u.test(content[next]!)
        ) {
          index = next;
          continue;
        }
      }
      if (/\s/.test(content[index]!)) {
        const start = index;
        while (index < content.length && /\s/.test(content[index]!)) index++;
        if (
          chars.length > 0 &&
          index < content.length &&
          chars.at(-1) !== " "
        ) {
          chars.push(" ");
          starts.push(start);
          ends.push(index);
        }
        continue;
      }
      chars.push(content[index]!);
      starts.push(index);
      ends.push(index + 1);
      index++;
    }
    const normalizedContent = chars.join("");
    const normalizedRequested = (
      dehyphenate
        ? requested.replace(/(\p{Letter})-\s+(?=\p{Letter})/gu, "$1")
        : requested
    )
      .trim()
      .replace(/\s+/g, " ");
    if (!normalizedRequested) return undefined;
    const normalizedOffset = normalizedContent.indexOf(normalizedRequested);
    if (
      normalizedOffset < 0 ||
      normalizedContent.indexOf(
        normalizedRequested,
        normalizedOffset + normalizedRequested.length,
      ) >= 0
    ) {
      return undefined;
    }
    const start = starts[normalizedOffset];
    const end = ends[normalizedOffset + normalizedRequested.length - 1];
    if (start === undefined || end === undefined) return undefined;
    return { quote: content.slice(start, end), offset: start };
  };

  return normalizedMatch(false) ?? normalizedMatch(true);
}

function sourceAnalysis(
  value: unknown,
  source: SourceArtifact,
  chunk: SourceChunk,
): SourceAnalysis {
  const data = object(value, "analysis");
  if (typeof data.relevant !== "boolean")
    throw new Error("analysis.relevant must be boolean");
  if (!Array.isArray(data.claims) || data.claims.length > 8)
    throw new Error("analysis.claims must contain at most 8 claims");
  const rawClaims = Array.isArray(data.claims)
    ? data.claims.map((item, index) => {
        const claim = object(item, `analysis.claims[${index}]`);
        return {
          id: text(claim.id, `analysis.claims[${index}].id`, 120),
          text: text(claim.text, `analysis.claims[${index}].text`),
          quote: text(claim.quote, `analysis.claims[${index}].quote`, 2_000),
        };
      })
    : (() => {
        throw new Error("analysis.claims must be an array");
      })();
  unique(
    rawClaims.map((claim) => claim.id),
    "analysis claim IDs",
  );
  const claims: AnalysisClaim[] = [];
  const rejectedClaims = Array.isArray(data.rejectedClaims)
    ? strings(data.rejectedClaims, "analysis.rejectedClaims", 50)
    : [];
  for (const claim of rawClaims) {
    const resolvedQuote = resolveExactQuote(chunk.content, claim.quote);
    if (!resolvedQuote || !source.content.includes(resolvedQuote.quote)) {
      rejectedClaims.push(
        `${claim.id}: quote is not present in chunk ${chunk.id}`,
      );
      continue;
    }
    claims.push({
      ...claim,
      quote: resolvedQuote.quote,
      locator: {
        sourceId: source.id,
        chunkId: chunk.id,
        chunkIndex: chunk.index,
        ...(chunk.section ? { section: chunk.section } : {}),
        start: chunk.start + resolvedQuote.offset,
        end: chunk.start + resolvedQuote.offset + resolvedQuote.quote.length,
        ...(chunk.page === undefined ? {} : { page: chunk.page }),
      },
    });
  }
  if (!Array.isArray(data.concepts) || data.concepts.length > 6)
    throw new Error("analysis.concepts must contain at most 6 concepts");
  const rawConcepts = (
    Array.isArray(data.concepts)
      ? data.concepts
      : (() => {
          throw new Error("analysis.concepts must be an array");
        })()
  ).map((item, index) => {
    const concept = object(item, `analysis.concepts[${index}]`);
    const claimIds = strings(
      concept.claimIds,
      `analysis.concepts[${index}].claimIds`,
    );
    if (!claimIds.length)
      throw new Error(
        "analysis concept definitions must cite at least one claim",
      );
    if (claimIds.some((id) => !rawClaims.some((claim) => claim.id === id)))
      throw new Error("analysis concept references an unknown claim ID");
    return {
      id: text(concept.id, `analysis.concepts[${index}].id`, 120),
      title: text(concept.title, `analysis.concepts[${index}].title`, 240),
      definition: text(
        concept.definition,
        `analysis.concepts[${index}].definition`,
        2_000,
      ),
      claimIds,
    };
  });
  const concepts = rawConcepts
    .map((concept) => ({
      ...concept,
      claimIds: concept.claimIds.filter((id) =>
        claims.some((claim) => claim.id === id),
      ),
    }))
    .filter((concept) => concept.claimIds.length > 0);
  unique(
    concepts.map((concept) => concept.id),
    "analysis concept IDs",
  );
  if (!data.relevant && (rawClaims.length || rawConcepts.length))
    throw new Error("irrelevant analyses must not contain claims or concepts");
  const summary = data.relevant
    ? text(data.summary, "analysis.summary")
    : typeof data.summary === "string" && data.summary.length <= 8_000
      ? data.summary.trim()
      : (() => {
          throw new Error(
            "analysis.summary must be a string for irrelevant sources",
          );
        })();
  const exclusionReason = data.relevant
    ? data.exclusionReason === undefined || data.exclusionReason === null
      ? ""
      : typeof data.exclusionReason === "string" &&
          data.exclusionReason.length <= 8_000
        ? data.exclusionReason.trim()
        : (() => {
            throw new Error(
              "analysis.exclusionReason must be a string when provided",
            );
          })()
    : text(data.exclusionReason, "analysis.exclusionReason");
  return {
    relevant: data.relevant,
    exclusionReason,
    summary,
    concepts,
    claims,
    rejectedClaims,
  };
}
function synthesis(
  value: unknown,
  analyses: Map<string, SourceAnalysis>,
  sources: Map<string, SourceArtifact>,
  summaryClaimLimit = 16,
): Synthesis {
  const data = object(value, "synthesis");
  const knownClaims = new Set(
    [...analyses].flatMap(([sourceId, a]) =>
      a.claims.map((claim) => `${sourceId}:${claim.id}`),
    ),
  );
  if (!Array.isArray(data.concepts) || data.concepts.length > 8)
    throw new Error("synthesis.concepts must contain at most 8 concepts");
  const concepts = data.concepts.map((item, i) => {
    const c = object(item, `synthesis.concepts[${i}]`);
    const claimIds = strings(c.claimIds, `synthesis.concepts[${i}].claimIds`);
    if (!claimIds.length)
      throw new Error(
        "synthesis concept definitions must cite at least one claim",
      );
    if (claimIds.some((id) => !knownClaims.has(id)))
      throw new Error("synthesis references an unknown claim ID");
    return {
      id: text(c.id, `synthesis.concepts[${i}].id`, 120),
      title: text(c.title, `synthesis.concepts[${i}].title`, 240),
      definition: text(
        c.definition,
        `synthesis.concepts[${i}].definition`,
        2_000,
      ),
      claimIds,
    };
  });
  unique(
    concepts.map((concept) => concept.id),
    "synthesis concept IDs",
  );
  const conceptIds = new Set(concepts.map((c) => c.id));
  if (!Array.isArray(data.claims) || data.claims.length > summaryClaimLimit)
    throw new Error(
      `synthesis.claims must contain at most ${summaryClaimLimit} claims`,
    );
  const claims = data.claims.map((item, i) => {
    const c = object(item, `synthesis.claims[${i}]`);
    const sourceId = text(c.sourceId, `synthesis.claims[${i}].sourceId`, 80);
    const source = sources.get(sourceId);
    if (!source || !analyses.get(sourceId)?.relevant)
      throw new Error("synthesis references an unknown or irrelevant source");
    const quote = text(c.quote, `synthesis.claims[${i}].quote`, 2_000);
    if (!source.content.includes(quote))
      throw new Error(`synthesis quote is not present in source ${sourceId}`);
    const conceptIdsForClaim = strings(
      c.conceptIds,
      `synthesis.claims[${i}].conceptIds`,
    );
    if (conceptIdsForClaim.some((id) => !conceptIds.has(id)))
      throw new Error("synthesis claim references an unknown concept");
    const id = text(c.id, `synthesis.claims[${i}].id`, 120);
    if (!knownClaims.has(id))
      throw new Error("synthesis claim references an unknown source claim ID");
    const sourceClaimId = id.slice(sourceId.length + 1);
    const sourceClaim = analyses
      .get(sourceId)
      ?.claims.find((claim) => claim.id === sourceClaimId);
    const claimText = text(c.text, `synthesis.claims[${i}].text`);
    if (
      !sourceClaim ||
      sourceClaim.quote !== quote ||
      sourceClaim.text !== claimText
    ) {
      throw new Error(
        "synthesis claim must exactly preserve its validated source claim",
      );
    }
    return {
      id,
      sourceId,
      quote,
      text: claimText,
      conceptIds: conceptIdsForClaim,
      locator: sourceClaim.locator,
    };
  });
  unique(
    claims.map((claim) => claim.id),
    "synthesis claim IDs",
  );
  const claimIds = new Set(claims.map((c) => c.id));
  for (const concept of concepts) {
    if (concept.claimIds.some((id) => !claimIds.has(id))) {
      throw new Error(
        "synthesis concept references a claim omitted from synthesis.claims",
      );
    }
    for (const claimId of concept.claimIds) {
      if (
        !claims
          .find((claim) => claim.id === claimId)
          ?.conceptIds.includes(concept.id)
      ) {
        throw new Error(
          "synthesis concept and claim references must be bidirectional",
        );
      }
    }
  }
  for (const claim of claims) {
    for (const conceptId of claim.conceptIds) {
      if (
        !concepts
          .find((concept) => concept.id === conceptId)
          ?.claimIds.includes(claim.id)
      ) {
        throw new Error(
          "synthesis claim and concept references must be bidirectional",
        );
      }
    }
  }
  if (!Array.isArray(data.contradictions) || data.contradictions.length > 8)
    throw new Error("synthesis.contradictions must contain at most 8 entries");
  const contradictions = data.contradictions.map((item, i) => {
    const c = object(item, `synthesis.contradictions[${i}]`);
    const ids = strings(c.claimIds, `synthesis.contradictions[${i}].claimIds`);
    if (ids.some((id) => !claimIds.has(id)))
      throw new Error("synthesis contradiction references an unknown claim");
    return {
      claimIds: ids,
      description: text(
        c.description,
        `synthesis.contradictions[${i}].description`,
      ),
    };
  });
  if (!Array.isArray(data.gaps) || data.gaps.length > 8)
    throw new Error("synthesis.gaps must contain at most 8 entries");
  const gaps = data.gaps.map((item, i) => {
    const gap = object(item, `synthesis.gaps[${i}]`);
    if (
      typeof gap.priority !== "number" ||
      !Number.isInteger(gap.priority) ||
      gap.priority < 1 ||
      gap.priority > 10
    )
      throw new Error("gap priority must be 1-10");
    return {
      priority: gap.priority,
      description: text(gap.description, `synthesis.gaps[${i}].description`),
      searchQuery: text(
        gap.searchQuery,
        `synthesis.gaps[${i}].searchQuery`,
        500,
      ),
    };
  });
  return { concepts, claims, contradictions, gaps };
}

async function removeStaleGenerated(
  directory: string,
  wanted: Set<string>,
): Promise<void> {
  for (const file of await walkFiles(directory, ".md")) {
    if (wanted.has(file)) continue;
    const content = await readTextIfExists(file);
    if (
      content?.includes('generated: "true"') &&
      content.includes("<!-- llmwiki:generated:start -->")
    )
      await rm(file);
  }
}

async function analyzeSource(
  source: SourceArtifact,
  chunk: SourceChunk,
  researchFocus: string,
  maxTokens: number,
  provider: ReturnType<typeof requireLlm>,
  usage: LlmUsageTracker,
): Promise<SourceAnalysis> {
  const prompt = `Analyze this source chunk for research focus "${researchFocus}". Return JSON {relevant:boolean,exclusionReason:string,summary:string,concepts:[{id,title,definition,claimIds:string[]}],claims:[{id,text,quote}]}. Use at most 6 canonical concepts and 8 concise claims. Keep the summary under 180 words, each definition under 80 words, and each claim under 60 words. Concepts must be grounded by their claimIds. Every quote must be copied verbatim as a short exact substring from the supplied chunk; do not normalize punctuation, whitespace, symbols, or capitalization. If irrelevant, return empty concepts and claims.${chunk.section ? ` Section: ${chunk.section}.` : ""}\n\n${chunk.content}`;
  try {
    return await requestJson(
      provider,
      {
        purpose: "source-analysis",
        maxTokens,
        prompt,
      },
      (value) => sourceAnalysis(value, source, chunk),
      usage,
    );
  } catch (error) {
    if (
      !(error instanceof WikiLlmResponseError) ||
      (!error.message.includes("invalid schema") &&
        !error.message.includes("invalid JSON"))
    ) {
      throw error;
    }
    return requestJson(
      provider,
      {
        purpose: "source-analysis",
        maxTokens,
        prompt: `${prompt}\n\nYour previous response failed deterministic validation: ${error.message}. Return a corrected full JSON object. Copy every evidence quote directly from the source text without any edits.`,
      },
      (value) => sourceAnalysis(value, source, chunk),
      usage,
    );
  }
}

function cacheableAnalysis(analysis: SourceAnalysis) {
  return {
    relevant: analysis.relevant,
    exclusionReason: analysis.exclusionReason,
    summary: analysis.summary,
    concepts: analysis.concepts,
    claims: analysis.claims.map(({ id, text, quote }) => ({
      id,
      text,
      quote,
    })),
    rejectedClaims: analysis.rejectedClaims,
  };
}

function canonical(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, " ");
}

function markdownProse(value: string): string {
  return value.replace(/\[\[/g, "\\[\\[");
}

/**
 * The registry identity is evidence-derived, never a synthesis alias.  This
 * keeps it stable when summary selection, topic sharding, or LLM ordering
 * changes.
 */
function registryClaimId(sourceId: string, claim: AnalysisClaim): string {
  return `claim-${sha256(
    JSON.stringify({
      sourceId,
      text: claim.text,
      quote: claim.quote,
      locator: claim.locator,
    }),
  ).slice(0, 32)}`;
}

function completeRegistry(
  sourceList: SourceArtifact[],
  analyses: Map<string, SourceAnalysis>,
  rejectedBySource?: Map<string, Array<{ chunkId: string; reason: string }>>,
) {
  const claims = sourceList.flatMap((source) => {
    const analysis = analyses.get(source.id)!;
    return analysis.claims.map((claim) => ({
      id: registryClaimId(source.id, claim),
      sourceId: source.id,
      statement: claim.text,
      text: claim.text,
      quote: claim.quote,
      locator: claim.locator,
      sourceTitle: source.title,
      sourcePath: `wiki/sources/${slugify(source.title)}-${source.id.slice(0, 8)}.md`,
      ...(source.literature ? { literature: source.literature } : {}),
      conceptIds: analysis.concepts
        .filter((concept) => concept.claimIds.includes(claim.id))
        .map((concept) => `${source.id}:${concept.id}`),
      topicIds: [],
      status: "accepted" as const,
      sourceScore: 0,
      confidence: 0,
      evidenceStatus: "insufficient" as const,
      independentSupportSources: 0,
      supportCount: 0,
      qualifyCount: 0,
      duplicateCount: 0,
      contradictionCount: 0,
    }));
  });
  const rejectedClaims = sourceList.flatMap((source) =>
    (
      rejectedBySource?.get(source.id) ??
      analyses.get(source.id)!.rejectedClaims.map((reason) => ({
        chunkId: reason.match(/chunk ([a-f0-9]{64})/)?.[1] ?? "unknown",
        reason,
      }))
    ).map(({ chunkId, reason }) => ({
      sourceId: source.id,
      chunkId,
      reason,
      status: "rejected" as const,
    })),
  );
  const byAnalysisId = new Map<string, string>();
  for (const source of sourceList) {
    for (const claim of analyses.get(source.id)!.claims) {
      byAnalysisId.set(
        `${source.id}:${claim.id}`,
        registryClaimId(source.id, claim),
      );
    }
  }
  return { claims, rejectedClaims, byAnalysisId };
}

type RegistryEntry = ReturnType<typeof completeRegistry>["claims"][number];
interface RegistryTopic {
  id: string;
  title: string;
  claimIds: string[];
  overview?: string;
  conceptLabels?: string[];
  summaryClaimIds?: string[];
}
interface ClaimRelationship {
  from: string;
  to: string;
  type: "supports" | "contradicts" | "qualifies" | "duplicate";
  explanation: string;
}

const TOPIC_DEFINITIONS = [
  {
    id: "planning",
    title: "Planning",
    words: ["plan", "planning", "goal", "task", "strategy"],
  },
  {
    id: "tool-use",
    title: "Tool use",
    words: ["tool", "api", "function", "command", "browser"],
  },
  {
    id: "recovery",
    title: "Recovery",
    words: ["recover", "recovery", "retry", "failure", "error", "fallback"],
  },
  {
    id: "long-horizon",
    title: "Long-horizon",
    words: ["long-horizon", "long term", "long-term", "memory", "persistent"],
  },
  {
    id: "evaluation-reliability",
    title: "Evaluation and reliability",
    words: ["evaluat", "reliab", "test", "metric", "validat", "robust"],
  },
  {
    id: "multi-agent-alignment",
    title: "Multi-agent and alignment",
    words: ["multi-agent", "agent", "align", "coordinat", "collaborat"],
  },
] as const;

function routeTopics(claims: RegistryEntry[]): RegistryTopic[] {
  const topics = new Map<string, RegistryTopic>();
  const add = (id: string, title: string, claim: RegistryEntry) => {
    const topic = topics.get(id) ?? { id, title, claimIds: [] };
    topic.claimIds.push(claim.id);
    topics.set(id, topic);
    (claim.topicIds as string[]).push(id);
  };
  for (const claim of claims) {
    const haystack =
      `${claim.statement} ${claim.quote} ${claim.conceptIds.join(" ")}`.toLocaleLowerCase();
    for (const topic of TOPIC_DEFINITIONS) {
      if (
        (topic.words as readonly string[]).some((word) =>
          haystack.includes(word),
        )
      )
        add(topic.id, topic.title, claim);
    }
    if (!claim.topicIds.length) add("other", "Other", claim);
  }
  return [...topics.values()]
    .map((topic) => ({
      ...topic,
      claimIds: [...new Set(topic.claimIds)].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function relationshipWords(claim: RegistryEntry): Set<string> {
  return new Set(
    `${claim.statement} ${claim.quote}`
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}-]{3,}/gu)
      ?.filter(
        (word) =>
          ![
            "that",
            "this",
            "with",
            "from",
            "have",
            "will",
            "their",
            "which",
          ].includes(word),
      ) ?? [],
  );
}

function relationshipPairKey(from: string, to: string): string {
  return [from, to].sort().join("\u0000");
}

async function incrementalRelationshipSemanticScores(
  claims: RegistryEntry[],
  newClaimIds: Set<string>,
  config: Awaited<ReturnType<typeof loadConfig>>,
  embeddingProvider?: EmbeddingProvider,
): Promise<Map<string, number>> {
  if (!newClaimIds.size) return new Map();
  const index = await loadSemanticIndex(config.metaDir);
  if (!index) return new Map();
  const provider = embeddingProvider ?? configuredEmbeddingProvider(config);
  if (
    provider.model !== index.model ||
    (provider.configurationId ?? provider.model) !==
      (index.configurationId ?? index.model)
  ) {
    return new Map();
  }
  const newClaims = claims.filter((claim) => newClaimIds.has(claim.id));
  const vectors: number[][] = [];
  for (
    let offset = 0;
    offset < newClaims.length;
    offset += config.retrieval.embeddingBatchSize
  ) {
    vectors.push(
      ...(await provider.embed(
        newClaims
          .slice(offset, offset + config.retrieval.embeddingBatchSize)
          .map(
            (claim) =>
              `${claim.statement}\n${claim.quote}\n${claim.topicIds.join(" ")}`,
          ),
        "passage",
      )),
    );
  }
  const newVectors = new Map(
    newClaims.map((claim, index) => [claim.id, vectors[index]!]),
  );
  const indexedVectors = new Map(
    index.claims.map((entry) => [entry.claimId, entry.vector]),
  );
  const scores = new Map<string, number>();
  for (const claim of newClaims) {
    const vector = newVectors.get(claim.id)!;
    for (const other of claims) {
      if (other.id === claim.id) continue;
      const key = relationshipPairKey(claim.id, other.id);
      if (scores.has(key)) continue;
      const otherNew = newVectors.get(other.id);
      const score = otherNew
        ? vector.reduce(
            (total, value, index) => total + value * (otherNew[index] ?? 0),
            0,
          )
        : indexedVectors.has(other.id)
          ? semanticSimilarity(vector, indexedVectors.get(other.id)!)
          : 0;
      scores.set(key, Math.max(0, score));
    }
  }
  return scores;
}

function relationshipCandidates(
  claims: RegistryEntry[],
  maximum: number,
  requiredClaimIds?: Set<string>,
  semanticScores: Map<string, number> = new Map(),
  perClaim = 8,
  oppositionPerClaim = 4,
): Array<{ from: string; to: string }> {
  if (requiredClaimIds !== undefined && requiredClaimIds.size === 0) return [];
  const words = new Map(
    claims.map((claim) => [claim.id, relationshipWords(claim)]),
  );
  const candidates: Array<{
    from: string;
    to: string;
    score: number;
    opposition: boolean;
  }> = [];
  const oppositions = [
    ["increase", "decrease"],
    ["higher", "lower"],
    ["improve", "degrade"],
    ["reliable", "unreliable"],
    ["effective", "ineffective"],
    ["supports", "fails"],
    ["can", "cannot"],
    ["success", "failure"],
  ] as const;
  for (let left = 0; left < claims.length; left++) {
    for (let right = left + 1; right < claims.length; right++) {
      const a = claims[left]!;
      const b = claims[right]!;
      if (
        requiredClaimIds &&
        !requiredClaimIds.has(a.id) &&
        !requiredClaimIds.has(b.id)
      ) {
        continue;
      }
      const sharedTopic = a.topicIds.some((id) => b.topicIds.includes(id));
      const aWords = words.get(a.id)!;
      const bWords = words.get(b.id)!;
      const overlap = [...aWords].filter((word) => bWords.has(word)).length;
      const negation =
        /\b(not|never|no|cannot|fails?)\b/i.test(a.statement) !==
        /\b(not|never|no|cannot|fails?)\b/i.test(b.statement);
      const aText = a.statement.toLocaleLowerCase();
      const bText = b.statement.toLocaleLowerCase();
      const opposition = oppositions.some(
        ([positive, negative]) =>
          (aText.includes(positive) && bText.includes(negative)) ||
          (aText.includes(negative) && bText.includes(positive)),
      );
      const semantic = semanticScores.get(relationshipPairKey(a.id, b.id)) ?? 0;
      if (
        sharedTopic ||
        overlap >= 2 ||
        negation ||
        opposition ||
        semantic >= 0.45
      ) {
        candidates.push({
          from: a.id,
          to: b.id,
          score:
            (opposition ? 12 : 0) +
            (negation ? 10 : 0) +
            Math.min(overlap, 6) * 2 +
            (sharedTopic ? 3 : 0) +
            (a.sourceId !== b.sourceId ? 2 : 0) +
            Math.round(semantic * 10),
          opposition: opposition || negation,
        });
      }
    }
  }
  const ranked = candidates.sort(
    (a, b) =>
      b.score - a.score ||
      `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`),
  );
  if (!requiredClaimIds) {
    return ranked.slice(0, maximum).map(({ from, to }) => ({ from, to }));
  }
  const selected = new Map<string, (typeof ranked)[number]>();
  for (const claimId of requiredClaimIds) {
    const involving = ranked.filter(
      (candidate) => candidate.from === claimId || candidate.to === claimId,
    );
    for (const candidate of involving
      .filter((item) => item.opposition)
      .slice(0, oppositionPerClaim)) {
      selected.set(
        relationshipPairKey(candidate.from, candidate.to),
        candidate,
      );
    }
    for (const candidate of involving
      .filter((item) => !item.opposition)
      .slice(0, perClaim)) {
      selected.set(
        relationshipPairKey(candidate.from, candidate.to),
        candidate,
      );
    }
  }
  return [...selected.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`),
    )
    .slice(0, maximum)
    .map(({ from, to }) => ({ from, to }));
}

async function previousClaimRelationships(
  metaDir: string,
  claims: RegistryEntry[],
): Promise<{ claimIds: Set<string>; edges: ClaimRelationship[] }> {
  const content = await readTextIfExists(
    path.join(metaDir, "claim_graph.json"),
  );
  if (!content) return { claimIds: new Set(), edges: [] };
  const data = object(JSON.parse(content), "previous Claim graph");
  const currentClaimIds = new Set(claims.map((claim) => claim.id));
  const claimIds = new Set(
    Array.isArray(data.nodes)
      ? data.nodes
          .map((item, index) => {
            const node = object(item, `previous Claim graph nodes[${index}]`);
            return typeof node.id === "string" ? node.id : undefined;
          })
          .filter(
            (id): id is string =>
              typeof id === "string" && currentClaimIds.has(id),
          )
      : [],
  );
  const rawEdges = Array.isArray(data.edges)
    ? data.edges.filter((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new Error("previous Claim graph edge must be an object");
        }
        const edge = item as Record<string, unknown>;
        return (
          typeof edge.from === "string" &&
          typeof edge.to === "string" &&
          currentClaimIds.has(edge.from) &&
          currentClaimIds.has(edge.to)
        );
      })
    : [];
  const candidates = rawEdges.map((item) => {
    const edge = item as Record<string, unknown>;
    return { from: edge.from as string, to: edge.to as string };
  });
  return {
    claimIds,
    edges: relationshipsResult({ edges: rawEdges }, candidates),
  };
}

async function targetedRelationshipCandidates(
  metaDir: string,
  sources: SourceArtifact[],
  claims: RegistryEntry[],
): Promise<Array<{ from: string; to: string }>> {
  const content = await readTextIfExists(
    path.join(metaDir, "corroboration_plan.json"),
  );
  if (!content) return [];
  const data = object(JSON.parse(content), "corroboration plan");
  if (data.state === "completed" || !Array.isArray(data.targets)) return [];
  const targetIds = new Set(
    data.targets
      .map((item, index) => {
        const target = object(item, `corroboration targets[${index}]`);
        return typeof target.claimId === "string" ? target.claimId : undefined;
      })
      .filter((id): id is string => Boolean(id)),
  );
  const baseline = new Set(
    Array.isArray(data.baselineSourceIds)
      ? data.baselineSourceIds.filter(
          (id): id is string => typeof id === "string",
        )
      : [],
  );
  const generatedAt =
    typeof data.generatedAt === "string"
      ? Date.parse(data.generatedAt)
      : Number.NaN;
  const newSourceIds = new Set(
    sources
      .filter((source) =>
        baseline.size
          ? !baseline.has(source.id)
          : Number.isFinite(generatedAt) &&
            Date.parse(source.ingestedAt) >= generatedAt,
      )
      .map((source) => source.id),
  );
  if (!targetIds.size || !newSourceIds.size) return [];
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const pairs: Array<{ from: string; to: string }> = [];
  for (const targetId of targetIds) {
    const target = byId.get(targetId);
    if (!target) continue;
    const targetWords = relationshipWords(target);
    const ranked = claims
      .filter(
        (claim) =>
          newSourceIds.has(claim.sourceId) &&
          claim.sourceId !== target.sourceId &&
          claim.id !== target.id,
      )
      .map((claim) => ({
        claim,
        score:
          [...relationshipWords(claim)].filter((word) => targetWords.has(word))
            .length *
            2 +
          (claim.topicIds.some((id) => target.topicIds.includes(id)) ? 3 : 0),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.claim.id.localeCompare(right.claim.id),
      )
      .slice(0, 64);
    pairs.push(
      ...ranked.map(({ claim }) => ({
        from: target.id,
        to: claim.id,
      })),
    );
  }
  return pairs;
}

function topicResult(value: unknown, knownClaimIds: Set<string>) {
  const data = object(value, "topic synthesis");
  const overview =
    data.overview === undefined
      ? undefined
      : text(data.overview, "topic overview", 2_000);
  const conceptLabels =
    data.conceptLabels === undefined
      ? []
      : strings(data.conceptLabels, "topic conceptLabels", 12);
  const summaryClaimIds =
    data.summaryClaimIds === undefined
      ? []
      : strings(data.summaryClaimIds, "topic summaryClaimIds", 64);
  if (summaryClaimIds.some((id) => !knownClaimIds.has(id)))
    throw new Error("topic synthesis references an unknown claim ID");
  return {
    ...(overview ? { overview } : {}),
    conceptLabels,
    summaryClaimIds: summaryClaimIds.slice(0, 24),
  };
}

function recoverTruncatedTopic(
  value: string,
  knownClaimIds: Set<string>,
): ReturnType<typeof topicResult> | undefined {
  const text = value.trim().replace(/^```(?:json)?\s*/i, "");
  const marker = ',"summaryClaimIds":[';
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return undefined;
  let prefix: Record<string, unknown>;
  try {
    prefix = object(
      JSON.parse(`${text.slice(0, markerIndex)}}`),
      "truncated topic synthesis",
    );
  } catch {
    return undefined;
  }
  const completeClaimIds = [
    ...text.slice(markerIndex + marker.length).matchAll(/"(claim-[a-f0-9]+)"/g),
  ]
    .map((match) => match[1]!)
    .filter((id) => knownClaimIds.has(id));
  return topicResult(
    {
      ...prefix,
      summaryClaimIds: [...new Set(completeClaimIds)].slice(0, 24),
    },
    knownClaimIds,
  );
}

async function synthesizeTopics(
  topics: RegistryTopic[],
  claimsById: Map<string, RegistryEntry>,
  config: Awaited<ReturnType<typeof loadConfig>>,
  model: string,
  provider: ReturnType<typeof requireLlm>,
  usage: LlmUsageTracker,
): Promise<RegistryTopic[]> {
  return mapConcurrent(topics, config.llm.topicConcurrency, async (topic) => {
    const entries = topic.claimIds
      .map((id) => claimsById.get(id)!)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, config.llm.maxClaimsPerTopicPrompt)
      .map((claim) => ({
        id: claim.id,
        statement: claim.statement,
        quote: claim.quote,
        sourceId: claim.sourceId,
      }));
    const key = sha256(
      JSON.stringify({
        version: TOPIC_PROMPT_VERSION,
        model,
        focus: config.researchFocus,
        topic: topic.id,
        claims: entries,
      }),
    );
    const cache = path.join(config.metaDir, "topic-synthesis", `${key}.json`);
    const cached = await readTextIfExists(cache);
    const known = new Set(topic.claimIds);
    const prompt = `Summarize the immutable evidence claims in the "${topic.title}" topic for "${config.researchFocus}". Return JSON {overview?:string,conceptLabels?:string[],summaryClaimIds?:string[]}. Only supplied claim IDs may occur in summaryClaimIds. Do not change, add, or restate evidence metadata.\n${JSON.stringify(entries)}`;
    let value;
    if (cached) {
      value = topicResult(JSON.parse(cached), known);
    } else {
      const requestTopic = (requestPrompt: string) =>
        requestJson(
          provider,
          {
            purpose: "topic-synthesis",
            maxTokens: Math.min(config.llm.synthesisOutputTokens, 2_000),
            prompt: requestPrompt,
          },
          (response) => topicResult(response, known),
          usage,
        );
      try {
        value = await requestTopic(prompt);
      } catch (error) {
        if (
          error instanceof WikiLlmResponseError &&
          error.stopReason === "max_tokens" &&
          error.responseText
        ) {
          const recovered = recoverTruncatedTopic(error.responseText, known);
          if (recovered) {
            value = recovered;
            await writeText(cache, JSON.stringify(value, null, 2));
            return Object.assign(topic, value);
          }
        }
        if (
          !(error instanceof WikiLlmResponseError) ||
          (!error.message.includes("invalid schema") &&
            !error.message.includes("invalid JSON"))
        ) {
          throw error;
        }
        value = await requestTopic(
          error.responseText
            ? `Correct this topic synthesis to JSON {overview?:string,conceptLabels?:string[],summaryClaimIds?:string[]}. Valid claim IDs: ${[...known].join(", ")}. Return JSON only.\nPrevious output:\n${error.responseText}`
            : `${prompt}\nPrevious output failed validation: ${error.message}. Return corrected JSON only.`,
        );
      }
    }
    if (!cached) await writeText(cache, JSON.stringify(value, null, 2));
    return Object.assign(topic, value);
  });
}

function relationshipsResult(
  value: unknown,
  candidates: Array<{ from: string; to: string }>,
): ClaimRelationship[] {
  const data = object(value, "relationship analysis");
  if (data.edges === undefined) return [];
  if (!Array.isArray(data.edges))
    throw new Error("relationship edges must be an array");
  const allowable = new Set(
    candidates.map((edge) => [edge.from, edge.to].sort().join("\u0000")),
  );
  const output = new Map<string, ClaimRelationship>();
  for (const item of data.edges) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("relationship edge must be an object");
    const edge = item as Record<string, unknown>;
    if (typeof edge.from !== "string" || typeof edge.to !== "string")
      throw new Error("relationship edge IDs must be strings");
    if (edge.from === edge.to)
      throw new Error("relationship edge cannot reference itself");
    if (
      !["supports", "contradicts", "qualifies", "duplicate"].includes(
        edge.type as string,
      )
    )
      throw new Error("relationship edge type is invalid");
    if (typeof edge.explanation !== "string" || !edge.explanation.trim())
      throw new Error("relationship explanation is invalid");
    const [from, to] = [edge.from, edge.to].sort() as [string, string];
    if (!allowable.has(`${from}\u0000${to}`)) continue;
    const normalized: ClaimRelationship = {
      from,
      to,
      type: edge.type as ClaimRelationship["type"],
      explanation: edge.explanation.trim().split(/\s+/).slice(0, 30).join(" "),
    };
    const key = `${from}\u0000${to}\u0000${normalized.type}`;
    if (!output.has(key)) output.set(key, normalized);
  }
  return [...output.values()].sort((a, b) =>
    `${a.from}:${a.to}:${a.type}`.localeCompare(`${b.from}:${b.to}:${b.type}`),
  );
}

function recoverTruncatedRelationships(value: string): unknown | undefined {
  const text = value.trim().replace(/^```(?:json)?\s*/i, "");
  const marker = '"edges":[';
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const arrayStart = markerIndex + marker.length;
  let inString = false;
  let escaped = false;
  let objectDepth = 0;
  let lastCompleteObjectEnd: number | undefined;
  for (let index = arrayStart; index < text.length; index++) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") objectDepth++;
    else if (character === "}") {
      objectDepth--;
      if (objectDepth === 0) lastCompleteObjectEnd = index + 1;
    }
  }
  const end = lastCompleteObjectEnd ?? arrayStart;
  try {
    return JSON.parse(`${text.slice(0, end).replace(/,\s*$/, "")}]}`);
  } catch {
    return undefined;
  }
}

async function analyzeRelationships(
  claims: RegistryEntry[],
  config: Awaited<ReturnType<typeof loadConfig>>,
  model: string,
  provider: ReturnType<typeof requireLlm>,
  usage: LlmUsageTracker,
  targetedCandidates: Array<{ from: string; to: string }> = [],
  embeddingProvider?: EmbeddingProvider,
): Promise<ClaimRelationship[]> {
  const previous = await previousClaimRelationships(config.metaDir, claims);
  const newClaimIds = new Set(
    claims
      .filter((claim) => !previous.claimIds.has(claim.id))
      .map((claim) => claim.id),
  );
  const semanticScores = previous.claimIds.size
    ? await incrementalRelationshipSemanticScores(
        claims,
        newClaimIds,
        config,
        embeddingProvider,
      )
    : new Map<string, number>();
  const candidates = relationshipCandidates(
    claims,
    config.llm.maxRelationshipCandidates,
    previous.claimIds.size ? newClaimIds : undefined,
    semanticScores,
    config.llm.relationshipCandidatesPerClaim,
    config.llm.relationshipOppositionCandidatesPerClaim,
  );
  const seen = new Set(
    candidates.map((edge) => [edge.from, edge.to].sort().join("\u0000")),
  );
  for (const edge of targetedCandidates) {
    const key = [edge.from, edge.to].sort().join("\u0000");
    if (seen.has(key)) continue;
    candidates.push(edge);
    seen.add(key);
  }
  const batches = Array.from(
    {
      length: Math.ceil(candidates.length / config.llm.relationshipBatchSize),
    },
    (_, index) =>
      candidates.slice(
        index * config.llm.relationshipBatchSize,
        (index + 1) * config.llm.relationshipBatchSize,
      ),
  );
  const batchResults = await mapConcurrent(
    batches,
    config.llm.relationshipConcurrency,
    async (batch) => {
      const byId = new Map(claims.map((claim) => [claim.id, claim]));
      const input = batch.map((pair) => ({
        ...pair,
        fromClaim: {
          statement: byId.get(pair.from)!.statement,
          quote: byId.get(pair.from)!.quote,
          topicIds: byId.get(pair.from)!.topicIds,
        },
        toClaim: {
          statement: byId.get(pair.to)!.statement,
          quote: byId.get(pair.to)!.quote,
          topicIds: byId.get(pair.to)!.topicIds,
        },
      }));
      const key = sha256(
        JSON.stringify({
          version: RELATIONSHIP_PROMPT_VERSION,
          model,
          focus: config.researchFocus,
          batch: input,
        }),
      );
      const cache = path.join(
        config.metaDir,
        "relationship-analysis",
        `${key}.json`,
      );
      const cached = await readTextIfExists(cache);
      const prompt = `Classify only the supplied candidate claim pairs for "${config.researchFocus}". Return JSON {edges:[{from,to,type,explanation}]}. type is supports, contradicts, qualifies, or duplicate. Use contradicts when claims report opposing outcomes, trends, capabilities, or conclusions under comparable scope; use qualifies when scope or conditions explain the difference. Use only supplied IDs, no self edges. Keep each explanation to one sentence and at most 30 words.\n${JSON.stringify(input)}`;
      let edges: ClaimRelationship[];
      if (cached) {
        edges = relationshipsResult(JSON.parse(cached), batch);
      } else {
        const requestRelationships = (requestPrompt: string) =>
          requestJson(
            provider,
            {
              purpose: "relationship-analysis",
              maxTokens: Math.min(config.llm.synthesisOutputTokens, 6_000),
              prompt: requestPrompt,
            },
            (response) => relationshipsResult(response, batch),
            usage,
          );
        try {
          edges = await requestRelationships(prompt);
        } catch (error) {
          if (
            error instanceof WikiLlmResponseError &&
            error.stopReason === "max_tokens" &&
            error.responseText
          ) {
            const recovered = recoverTruncatedRelationships(error.responseText);
            if (recovered !== undefined) {
              edges = relationshipsResult(recovered, batch);
              if (!cached)
                await writeText(cache, JSON.stringify({ edges }, null, 2));
              return edges;
            }
          }
          if (
            !(error instanceof WikiLlmResponseError) ||
            (!error.message.includes("invalid schema") &&
              !error.message.includes("invalid JSON"))
          ) {
            throw error;
          }
          edges = await requestRelationships(
            error.responseText
              ? `Correct this relationship output to JSON {edges:[{from,to,type,explanation}]}. Allowed pairs: ${batch.map((pair) => `${pair.from}|${pair.to}`).join(", ")}. Types: supports, contradicts, qualifies, duplicate. Each explanation must be at most 30 words. Return JSON only.\nPrevious output:\n${error.responseText}`
              : `${prompt}\nPrevious output failed validation: ${error.message}. Return corrected JSON only.`,
          );
        }
      }
      if (!cached) await writeText(cache, JSON.stringify({ edges }, null, 2));
      return edges;
    },
  );
  const relationships = batchResults.flat();
  const merged = [...previous.edges, ...relationships];
  return relationshipsResult(
    { edges: merged },
    merged.map((edge) => ({ from: edge.from, to: edge.to })),
  );
}

async function mergeDurableTargetedRelationships(
  metaDir: string,
  claims: RegistryEntry[],
  analyzed: ClaimRelationship[],
  targetedCandidates: Array<{ from: string; to: string }>,
): Promise<ClaimRelationship[]> {
  const artifactPath = path.join(metaDir, "targeted_relationships.json");
  const knownClaims = new Set(claims.map((claim) => claim.id));
  const storedContent = await readTextIfExists(artifactPath);
  let durable: ClaimRelationship[] = [];
  if (storedContent) {
    const stored = object(JSON.parse(storedContent), "targeted relationships");
    if (!Array.isArray(stored.edges)) {
      throw new Error("targeted relationships edges must be an array");
    }
    const validStored = stored.edges.filter((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("targeted relationship edge must be an object");
      }
      const edge = item as Record<string, unknown>;
      if (typeof edge.from !== "string" || typeof edge.to !== "string") {
        throw new Error("targeted relationship edge IDs must be strings");
      }
      return knownClaims.has(edge.from) && knownClaims.has(edge.to);
    });
    durable = relationshipsResult(
      { edges: validStored },
      validStored.map((item) => {
        const edge = item as Record<string, unknown>;
        return { from: edge.from as string, to: edge.to as string };
      }),
    );
  }
  if (targetedCandidates.length) {
    const targetedPairs = new Set(
      targetedCandidates.map((edge) =>
        [edge.from, edge.to].sort().join("\u0000"),
      ),
    );
    const fresh = analyzed.filter((edge) =>
      targetedPairs.has([edge.from, edge.to].sort().join("\u0000")),
    );
    durable = relationshipsResult(
      { edges: [...durable, ...fresh] },
      [...durable, ...fresh].map((edge) => ({
        from: edge.from,
        to: edge.to,
      })),
    );
    await writeText(
      artifactPath,
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          edges: durable,
        },
        null,
        2,
      ),
    );
  }
  return relationshipsResult(
    { edges: [...analyzed, ...durable] },
    [...analyzed, ...durable].map((edge) => ({
      from: edge.from,
      to: edge.to,
    })),
  );
}

/** Merge independently validated chunks without asking an LLM to invent a merge. */
function mergeChunkAnalyses(
  _source: SourceArtifact,
  chunkAnalyses: Array<{ chunk: SourceChunk; analysis: SourceAnalysis }>,
): SourceAnalysis {
  const relevant = chunkAnalyses.some(({ analysis }) => analysis.relevant);
  const prefixIds = chunkAnalyses.length > 1;
  const rawClaims = chunkAnalyses.flatMap(({ chunk, analysis }) =>
    analysis.claims.map((claim) => ({
      ...claim,
      id: prefixIds
        ? `chunk-${chunk.index}-${chunk.id.slice(0, 10)}:${claim.id}`
        : claim.id,
    })),
  );
  const claims: AnalysisClaim[] = [];
  const claimIdMap = new Map<string, string>();
  const seenClaims = new Map<string, string>();
  for (const claim of rawClaims) {
    const key = `${claim.quote}\u0000${claim.text}`;
    const existing = seenClaims.get(key);
    if (existing) {
      claimIdMap.set(claim.id, existing);
      continue;
    }
    seenClaims.set(key, claim.id);
    claimIdMap.set(claim.id, claim.id);
    claims.push(claim);
  }
  const concepts = new Map<string, AnalysisConcept>();
  for (const { chunk, analysis } of chunkAnalyses) {
    for (const concept of analysis.concepts) {
      const originalPrefix = prefixIds
        ? `chunk-${chunk.index}-${chunk.id.slice(0, 10)}:`
        : "";
      const claimIds = [
        ...new Set(
          concept.claimIds
            .map((id) => claimIdMap.get(`${originalPrefix}${id}`))
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      if (!claimIds.length) continue;
      const id = prefixIds
        ? `concept-${chunk.index}-${chunk.id.slice(0, 10)}:${concept.id}`
        : concept.id;
      const key = canonical(concept.title) || canonical(concept.id);
      const existing = concepts.get(key);
      if (!existing) {
        concepts.set(key, { ...concept, id, claimIds });
        continue;
      }
      existing.claimIds = [...new Set([...existing.claimIds, ...claimIds])];
      if (concept.definition.length > existing.definition.length) {
        existing.definition = concept.definition;
        existing.title = concept.title;
      }
    }
  }
  const summaries = chunkAnalyses
    .filter(({ analysis }) => analysis.relevant)
    .map(({ analysis }) => analysis.summary)
    .filter(Boolean);
  const exclusions = chunkAnalyses
    .filter(({ analysis }) => !analysis.relevant)
    .map(({ analysis }) => analysis.exclusionReason)
    .filter(Boolean);
  return {
    relevant,
    exclusionReason: relevant
      ? (chunkAnalyses.find(({ analysis }) => analysis.relevant)?.analysis
          .exclusionReason ?? "")
      : (exclusions.sort((a, b) => b.length - a.length)[0] ??
        "No chunk was relevant to the research focus."),
    summary: summaries.sort((a, b) => b.length - a.length)[0] ?? "",
    concepts: [...concepts.values()],
    claims,
    rejectedClaims: chunkAnalyses.flatMap(
      ({ analysis }) => analysis.rejectedClaims,
    ),
  };
}

function projectSingleRelevantSource(
  sourceList: SourceArtifact[],
  analyses: Map<string, SourceAnalysis>,
  summaryClaimLimit: number,
): Synthesis {
  const source = sourceList.find((item) => analyses.get(item.id)?.relevant);
  if (!source) {
    return { concepts: [], claims: [], contradictions: [], gaps: [] };
  }
  const analysis = analyses.get(source.id)!;
  const selectedClaims =
    analysis.claims.length <= summaryClaimLimit
      ? analysis.claims
      : Array.from({ length: summaryClaimLimit }, (_, index) =>
          Math.round(
            (index * (analysis.claims.length - 1)) /
              Math.max(1, summaryClaimLimit - 1),
          ),
        )
          .filter((value, index, all) => all.indexOf(value) === index)
          .map((index) => analysis.claims[index]!);
  const selectedIds = new Set(selectedClaims.map((claim) => claim.id));
  const claims: SynthesisClaim[] = selectedClaims.map((claim) => ({
    id: `${source.id}:${claim.id}`,
    sourceId: source.id,
    quote: claim.quote,
    text: claim.text,
    locator: claim.locator,
    conceptIds: analysis.concepts
      .filter((concept) => concept.claimIds.includes(claim.id))
      .map((concept) => concept.id),
  }));
  return {
    concepts: analysis.concepts
      .map((concept) => ({
        id: concept.id,
        title: concept.title,
        definition: concept.definition,
        claimIds: concept.claimIds
          .filter((claimId) => selectedIds.has(claimId))
          .map((claimId) => `${source.id}:${claimId}`),
      }))
      .filter((concept) => concept.claimIds.length > 0),
    claims,
    contradictions: [],
    gaps: [],
  };
}

function synthesisAliases(
  sourceList: SourceArtifact[],
  analyses: Map<string, SourceAnalysis>,
  allowedClaimIds?: Set<string>,
  summaryClaimLimit = 16,
) {
  const claimAliasToId = new Map<string, string>();
  const claimAliasDetails = new Map<
    string,
    { id: string; sourceId: string; text: string; quote: string }
  >();
  let claimIndex = 0;
  const input = sourceList
    .filter((source) => analyses.get(source.id)?.relevant)
    .map((source, sourceIndex) => {
      const sourceAlias = `s${sourceIndex + 1}`;
      const analysis = analyses.get(source.id)!;
      const eligibleClaims = allowedClaimIds
        ? analysis.claims.filter((claim) =>
            allowedClaimIds.has(`${source.id}:${claim.id}`),
          )
        : analysis.claims;
      const selectedClaims =
        eligibleClaims.length <= 24
          ? eligibleClaims
          : Array.from({ length: 24 }, (_, index) =>
              Math.round((index * (eligibleClaims.length - 1)) / 23),
            )
              .filter((value, index, all) => all.indexOf(value) === index)
              .map((index) => eligibleClaims[index]!);
      const claims = selectedClaims.map((claim) => {
        const fullId = `${source.id}:${claim.id}`;
        const alias = `q${++claimIndex}`;
        claimAliasToId.set(alias, fullId);
        claimAliasDetails.set(alias, {
          id: fullId,
          sourceId: source.id,
          text: claim.text,
          quote: claim.quote,
        });
        return { id: alias, text: claim.text.slice(0, 120) };
      });
      return {
        sourceId: sourceAlias,
        claims,
      };
    });

  const resolveAlias = (
    value: unknown,
    aliases: Map<string, string>,
    label: string,
  ): unknown => {
    if (typeof value !== "string") return value;
    const resolved = aliases.get(value);
    if (!resolved) throw new Error(`${label} references an unknown alias`);
    return resolved;
  };

  const expand = (value: unknown): unknown => {
    const data = object(value, "synthesis");
    const selectedClaimItems = Array.isArray(data.claims)
      ? data.claims.slice(0, summaryClaimLimit)
      : [];
    const selectedClaimAliases = new Set(
      selectedClaimItems
        .map((item, index) => {
          const claim = object(item, `synthesis.claims[${index}]`);
          return typeof claim.id === "string" ? claim.id : undefined;
        })
        .filter((id): id is string => Boolean(id)),
    );
    const allConceptIds = new Set(
      Array.isArray(data.concepts)
        ? data.concepts
            .map((item, index) => {
              const concept = object(item, `synthesis.concepts[${index}]`);
              return typeof concept.id === "string" ? concept.id : undefined;
            })
            .filter((id): id is string => Boolean(id))
        : [],
    );
    const conceptClaimAliases = new Map<string, Set<string>>();
    if (Array.isArray(data.concepts)) {
      for (const [index, item] of data.concepts.entries()) {
        const concept = object(item, `synthesis.concepts[${index}]`);
        if (typeof concept.id !== "string") continue;
        const aliases = new Set<string>();
        if (Array.isArray(concept.claimIds)) {
          for (const id of concept.claimIds) {
            resolveAlias(id, claimAliasToId, "synthesis concept");
            if (typeof id === "string" && selectedClaimAliases.has(id)) {
              aliases.add(id);
            }
          }
        }
        conceptClaimAliases.set(concept.id, aliases);
      }
    }
    if (selectedClaimItems.length) {
      for (const [index, item] of selectedClaimItems.entries()) {
        const claim = object(item, `synthesis.claims[${index}]`);
        if (
          typeof claim.id !== "string" ||
          !selectedClaimAliases.has(claim.id) ||
          !Array.isArray(claim.conceptIds)
        ) {
          continue;
        }
        for (const conceptId of claim.conceptIds) {
          if (typeof conceptId !== "string" || !allConceptIds.has(conceptId)) {
            throw new Error("synthesis claim references an unknown concept");
          }
          conceptClaimAliases.get(conceptId)?.add(claim.id);
        }
      }
    }
    const selectedConceptIds = new Set(
      [...conceptClaimAliases]
        .filter(([, aliases]) => aliases.size > 0)
        .map(([conceptId]) => conceptId),
    );
    return {
      ...data,
      concepts: Array.isArray(data.concepts)
        ? data.concepts
            .map((item, index) => {
              const concept = object(item, `synthesis.concepts[${index}]`);
              return {
                ...concept,
                claimIds:
                  typeof concept.id === "string"
                    ? [...(conceptClaimAliases.get(concept.id) ?? [])].map(
                        (id) =>
                          resolveAlias(id, claimAliasToId, "synthesis concept"),
                      )
                    : concept.claimIds,
              };
            })
            .filter(
              (concept) =>
                Array.isArray(concept.claimIds) && concept.claimIds.length > 0,
            )
        : data.concepts,
      claims: Array.isArray(data.claims)
        ? selectedClaimItems.map((item, index) => {
            const claim = object(item, `synthesis.claims[${index}]`);
            if (typeof claim.id !== "string")
              throw new Error("synthesis claim ID must be an alias");
            const details = claimAliasDetails.get(claim.id);
            if (!details)
              throw new Error("synthesis claim references an unknown alias");
            return {
              ...claim,
              id: details.id,
              sourceId: details.sourceId,
              text: details.text,
              quote: details.quote,
              conceptIds: [...conceptClaimAliases]
                .filter(
                  ([conceptId, aliases]) =>
                    selectedConceptIds.has(conceptId) &&
                    aliases.has(claim.id as string),
                )
                .map(([conceptId]) => conceptId),
            };
          })
        : data.claims,
      contradictions: Array.isArray(data.contradictions)
        ? data.contradictions
            .map((item, index) => {
              const contradiction = object(
                item,
                `synthesis.contradictions[${index}]`,
              );
              return {
                ...contradiction,
                claimIds: Array.isArray(contradiction.claimIds)
                  ? contradiction.claimIds
                      .map((id) => {
                        resolveAlias(
                          id,
                          claimAliasToId,
                          "synthesis contradiction",
                        );
                        return id;
                      })
                      .filter(
                        (id): id is string =>
                          typeof id === "string" &&
                          selectedClaimAliases.has(id),
                      )
                      .map((id) =>
                        resolveAlias(
                          id,
                          claimAliasToId,
                          "synthesis contradiction",
                        ),
                      )
                  : contradiction.claimIds,
              };
            })
            .filter(
              (contradiction) =>
                Array.isArray(contradiction.claimIds) &&
                contradiction.claimIds.length >= 2,
            )
        : data.contradictions,
      gaps: Array.isArray(data.gaps)
        ? data.gaps.map((item, index) => {
            const gap = object(item, `synthesis.gaps[${index}]`);
            const priority =
              gap.priority === "high"
                ? 9
                : gap.priority === "medium"
                  ? 5
                  : gap.priority === "low"
                    ? 2
                    : gap.priority;
            return { ...gap, priority };
          })
        : data.gaps,
    };
  };

  return { input, expand };
}

function reusePreviousTopics(
  topics: RegistryTopic[],
  previousRegistry: Record<string, unknown>,
  currentClaimIds: Set<string>,
): RegistryTopic[] {
  const previous = new Map(
    Array.isArray(previousRegistry.topics)
      ? previousRegistry.topics.flatMap((item, index) => {
          const topic = object(item, `previous topics[${index}]`);
          return typeof topic.id === "string"
            ? [[topic.id, topic] as const]
            : [];
        })
      : [],
  );
  return topics.map((topic) => {
    const prior = previous.get(topic.id);
    return {
      ...topic,
      ...(typeof prior?.overview === "string"
        ? { overview: prior.overview }
        : {}),
      ...(Array.isArray(prior?.conceptLabels)
        ? {
            conceptLabels: prior.conceptLabels.filter(
              (label): label is string => typeof label === "string",
            ),
          }
        : {}),
      ...(Array.isArray(prior?.summaryClaimIds)
        ? {
            summaryClaimIds: prior.summaryClaimIds.filter(
              (id): id is string =>
                typeof id === "string" && currentClaimIds.has(id),
            ),
          }
        : {}),
    };
  });
}

async function reusePreviousSynthesis(
  previousGraph: Record<string, unknown>,
  registryById: Map<string, RegistryEntry>,
  metaDir: string,
): Promise<Synthesis> {
  const priorClaims = Array.isArray(previousGraph.claims)
    ? previousGraph.claims
    : [];
  const claims = priorClaims.flatMap((item, index): SynthesisClaim[] => {
    const prior = object(item, `previous summary claims[${index}]`);
    if (typeof prior.id !== "string") return [];
    const claim = registryById.get(prior.id);
    if (!claim) return [];
    return [
      {
        id: claim.id,
        sourceId: claim.sourceId,
        quote: claim.quote,
        text: claim.statement,
        locator: claim.locator,
        conceptIds: Array.isArray(prior.conceptIds)
          ? prior.conceptIds.filter(
              (id): id is string => typeof id === "string",
            )
          : [],
      },
    ];
  });
  const summaryIds = new Set(claims.map((claim) => claim.id));
  const concepts = Array.isArray(previousGraph.concepts)
    ? previousGraph.concepts.flatMap((item, index) => {
        const concept = object(item, `previous concepts[${index}]`);
        if (
          typeof concept.id !== "string" ||
          typeof concept.title !== "string" ||
          typeof concept.definition !== "string" ||
          !Array.isArray(concept.claimIds)
        ) {
          return [];
        }
        const claimIds = concept.claimIds.filter(
          (id): id is string => typeof id === "string" && summaryIds.has(id),
        );
        return claimIds.length
          ? [
              {
                id: concept.id,
                title: concept.title,
                definition: concept.definition,
                claimIds,
              },
            ]
          : [];
      })
    : [];
  const priorContradictions = Array.isArray(previousGraph.summaryContradictions)
    ? previousGraph.summaryContradictions
    : [];
  const contradictions = priorContradictions.flatMap((item, index) => {
    const contradiction = object(
      item,
      `previous summary contradictions[${index}]`,
    );
    if (
      !Array.isArray(contradiction.claimIds) ||
      typeof contradiction.description !== "string"
    ) {
      return [];
    }
    const claimIds = contradiction.claimIds.filter(
      (id): id is string => typeof id === "string" && summaryIds.has(id),
    );
    return claimIds.length >= 2
      ? [{ claimIds, description: contradiction.description }]
      : [];
  });
  const gapsContent = await readTextIfExists(path.join(metaDir, "gaps.json"));
  const gapsData = gapsContent
    ? object(JSON.parse(gapsContent), "previous gaps")
    : {};
  const gaps = Array.isArray(gapsData.gaps)
    ? gapsData.gaps.flatMap((item, index) => {
        const gap = object(item, `previous gaps[${index}]`);
        return typeof gap.priority === "number" &&
          typeof gap.description === "string" &&
          typeof gap.searchQuery === "string"
          ? [
              {
                priority: gap.priority,
                description: gap.description,
                searchQuery: gap.searchQuery,
              },
            ]
          : [];
      })
    : [];
  return { concepts, claims, contradictions, gaps };
}

function recoverTruncatedSynthesis(value: string): unknown | undefined {
  const text = value.trim().replace(/^```(?:json)?\s*/i, "");
  const marker = '"gaps":[';
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const arrayStart = markerIndex + marker.length;
  let inString = false;
  let escaped = false;
  let objectDepth = 0;
  let arrayDepth = 1;
  let lastCompleteObjectEnd: number | undefined;
  for (let index = arrayStart; index < text.length; index++) {
    const character = text[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      objectDepth++;
    } else if (character === "}") {
      objectDepth--;
      if (objectDepth === 0 && arrayDepth === 1) {
        lastCompleteObjectEnd = index + 1;
      }
    } else if (character === "[") {
      arrayDepth++;
    } else if (character === "]") {
      arrayDepth--;
    }
  }
  const end = lastCompleteObjectEnd ?? arrayStart;
  try {
    return JSON.parse(`${text.slice(0, end).replace(/,\s*$/, "")}]}`);
  } catch {
    return undefined;
  }
}

export async function compileWiki(
  options: ServiceOptions = {},
): Promise<CompileResult> {
  const config = await loadConfig(options.root);
  const provider = requireLlm(config, options);
  const sourceList = await artifacts(config.sourcesDir);
  const previousGraphContent = await readTextIfExists(
    path.join(config.metaDir, "knowledge_graph.json"),
  );
  const previousGraph = previousGraphContent
    ? object(JSON.parse(previousGraphContent), "previous knowledge graph")
    : {};
  const previousRegistryContent = await readTextIfExists(
    path.join(config.metaDir, "claims.json"),
  );
  const previousRegistry = previousRegistryContent
    ? object(JSON.parse(previousRegistryContent), "previous Claim Registry")
    : {};
  const previousCapabilitiesContent = await readTextIfExists(
    path.join(config.metaDir, "capabilities.json"),
  );
  const previousCapabilities = previousCapabilitiesContent
    ? object(JSON.parse(previousCapabilitiesContent), "previous capabilities")
    : {};
  const previousSourceCount = Array.isArray(previousGraph.sources)
    ? previousGraph.sources.length
    : 0;
  const evidenceSourceCount = sourceList.filter(
    (source) => !source.mediaType.includes("llmwiki.search-result"),
  ).length;
  const lastGlobalSynthesisEvidenceSourceCount =
    typeof previousCapabilities.lastGlobalSynthesisEvidenceSourceCount ===
    "number"
      ? previousCapabilities.lastGlobalSynthesisEvidenceSourceCount
      : evidenceSourceCount;
  const deferGlobalSynthesis =
    options.deferGlobalSynthesis === true &&
    previousSourceCount > 0 &&
    evidenceSourceCount - lastGlobalSynthesisEvidenceSourceCount <
      config.llm.globalSynthesisSourceInterval;
  const previousCompiledSourceIds = new Set(
    Array.isArray(previousGraph.sources)
      ? previousGraph.sources
          .map((item, index) => {
            const source = object(
              item,
              `previous knowledge graph sources[${index}]`,
            );
            return typeof source.id === "string" ? source.id : undefined;
          })
          .filter((id): id is string => typeof id === "string")
      : [],
  );
  // Build every plan before obtaining a provider response: overflow must never
  // spend tokens for earlier sources/chunks.
  const chunksBySource = new Map(
    sourceList.map((source) => [
      source.id,
      chunkSource(
        source,
        previousCompiledSourceIds.has(source.id)
          ? {
              chunkInputChars: config.llm.chunkInputChars,
              chunkOverlapChars: config.llm.chunkOverlapChars,
              maxChunksPerSource: config.llm.maxChunksPerSource,
            }
          : config.llm,
      ),
    ]),
  );
  const model = cleanModel(process.env.ANTHROPIC_MODEL ?? config.llm.model);
  const analyses = new Map<string, SourceAnalysis>();
  const rejectedBySource = new Map<
    string,
    Array<{ chunkId: string; reason: string }>
  >();
  const usage = new LlmUsageTracker(options.maxLlmTokens);
  const chunkTasks = sourceList.flatMap((source) =>
    (chunksBySource.get(source.id) ?? []).map((chunk) => ({ source, chunk })),
  );
  const analyzedChunks = await mapConcurrent(
    chunkTasks,
    config.llm.analysisConcurrency,
    async ({ source, chunk }) => {
      const key = sha256(
        JSON.stringify({
          chunkHash: chunk.hash,
          section: chunk.section,
          model,
          thinking: config.llm.thinking,
          promptVersion: SOURCE_PROMPT_VERSION,
          researchFocus: config.researchFocus,
          promptLimits: {
            analysisOutputTokens: config.llm.analysisOutputTokens,
          },
        }),
      );
      const cache = path.join(config.metaDir, "llm-cache", `${key}.json`);
      const cached = await readTextIfExists(cache);
      const analysis = cached
        ? sourceAnalysis(JSON.parse(cached), source, chunk)
        : await analyzeSource(
            source,
            chunk,
            config.researchFocus,
            config.llm.analysisOutputTokens,
            provider,
            usage,
          );
      if (!cached)
        await writeText(
          cache,
          JSON.stringify(cacheableAnalysis(analysis), null, 2),
        );
      return { source, chunk, analysis };
    },
  );
  const chunksByAnalyzedSource = new Map<
    string,
    Array<{ chunk: SourceChunk; analysis: SourceAnalysis }>
  >();
  for (const { source, chunk, analysis } of analyzedChunks) {
    const chunkAnalyses = chunksByAnalyzedSource.get(source.id) ?? [];
    chunkAnalyses.push({ chunk, analysis });
    chunksByAnalyzedSource.set(source.id, chunkAnalyses);
    for (const reason of analysis.rejectedClaims) {
      const entries = rejectedBySource.get(source.id) ?? [];
      entries.push({ chunkId: chunk.id, reason });
      rejectedBySource.set(source.id, entries);
    }
  }
  for (const source of sourceList) {
    const chunkAnalyses = (chunksByAnalyzedSource.get(source.id) ?? []).sort(
      (left, right) => left.chunk.index - right.chunk.index,
    );
    analyses.set(source.id, mergeChunkAnalyses(source, chunkAnalyses));
  }
  const sourceMap = new Map(sourceList.map((source) => [source.id, source]));
  const registry = completeRegistry(sourceList, analyses, rejectedBySource);
  const registryById = new Map(
    registry.claims.map((claim) => [claim.id, claim]),
  );
  const routedTopics = routeTopics(registry.claims);
  const topics = deferGlobalSynthesis
    ? reusePreviousTopics(
        routedTopics,
        previousRegistry,
        new Set(registry.claims.map((claim) => claim.id)),
      )
    : await synthesizeTopics(
        routedTopics,
        registryById,
        config,
        model,
        provider,
        usage,
      );
  let relationshipEdges: ClaimRelationship[];
  if (deferGlobalSynthesis) {
    relationshipEdges = (
      await previousClaimRelationships(config.metaDir, registry.claims)
    ).edges;
  } else {
    const targetedCandidates = await targetedRelationshipCandidates(
      config.metaDir,
      sourceList,
      registry.claims,
    );
    const analyzedRelationshipEdges = await analyzeRelationships(
      registry.claims,
      config,
      model,
      provider,
      usage,
      targetedCandidates,
      options.embeddingProvider,
    );
    relationshipEdges = await mergeDurableTargetedRelationships(
      config.metaDir,
      registry.claims,
      analyzedRelationshipEdges,
      targetedCandidates,
    );
  }
  const preliminaryQuality = buildQualityArtifacts(
    sourceList,
    registry.claims,
    relationshipEdges,
    options.now?.() ?? new Date(),
  );
  const confidenceByRegistryId = new Map(
    preliminaryQuality.claimConfidence.map((entry) => [entry.claimId, entry]),
  );
  const eligibleSummaryAnalysisIds = new Set(
    [...registry.byAnalysisId]
      .filter(([, claimId]) => {
        const confidence = confidenceByRegistryId.get(claimId);
        return (
          confidence &&
          (confidence.independentSupportSources >= 1 ||
            confidence.evidenceStatus === "contested" ||
            confidence.evidenceStatus === "insufficient")
        );
      })
      .map(([analysisId]) => analysisId),
  );
  const summaryEligibility =
    eligibleSummaryAnalysisIds.size >= config.llm.summaryClaimLimit
      ? eligibleSummaryAnalysisIds
      : undefined;
  const relevantSourceCount = sourceList.filter(
    (source) => analyses.get(source.id)?.relevant,
  ).length;
  const synthesisInput = sourceList.map((source) => ({
    sourceId: source.id,
    relevant: analyses.get(source.id)!.relevant,
    claims: analyses.get(source.id)!.claims.map((c) => ({
      id: `${source.id}:${c.id}`,
      text: c.text,
      quote: c.quote,
    })),
    concepts: analyses.get(source.id)!.concepts,
  }));
  const aliases = synthesisAliases(
    sourceList,
    analyses,
    summaryEligibility,
    config.llm.summaryClaimLimit,
  );
  const synthKey = sha256(
    JSON.stringify({
      model,
      promptVersion: SYNTHESIS_PROMPT_VERSION,
      researchFocus: config.researchFocus,
      llm: config.llm,
      synthesisInput,
      eligibleSummaryClaimIds: summaryEligibility
        ? [...summaryEligibility].sort()
        : undefined,
    }),
  );
  const synthesisCache = path.join(
    config.metaDir,
    "llm-synthesis",
    `${synthKey}.json`,
  );
  const existingSynthesis = await readTextIfExists(synthesisCache);
  const synthesisPrompt = `Synthesize these validated claim summaries for research focus "${config.researchFocus}". Return JSON {concepts:[{id,title,definition,claimIds}],claims:[{id,conceptIds}],contradictions:[{claimIds,description}],gaps:[{priority,description,searchQuery}]}. Use at most 8 concepts, ${config.llm.summaryClaimLimit} claims, 8 contradictions, and 8 gaps. Claim IDs must be supplied q# aliases. Do not repeat source IDs, claim text, or quotes; the compiler restores them from validated evidence. Every concept definition must cite claimIds.${summaryEligibility ? " The supplied candidates already satisfy the evidence-strength gate; select the most decision-relevant among them." : ""}\n${JSON.stringify(aliases.input)}`;
  const validClaimAliases = aliases.input.flatMap((source) =>
    source.claims.map((claim) => claim.id),
  );
  let result: Synthesis;
  let resultUsesRegistryIds = false;
  if (deferGlobalSynthesis) {
    result = await reusePreviousSynthesis(
      previousGraph,
      registryById,
      config.metaDir,
    );
    resultUsesRegistryIds = true;
  } else if (relevantSourceCount <= 1) {
    result = projectSingleRelevantSource(
      sourceList,
      analyses,
      config.llm.summaryClaimLimit,
    );
  } else if (existingSynthesis) {
    result = synthesis(
      JSON.parse(existingSynthesis),
      analyses,
      sourceMap,
      config.llm.summaryClaimLimit,
    );
  } else {
    const requestSynthesis = (prompt: string) =>
      requestJson(
        provider,
        {
          purpose: "synthesis",
          maxTokens: config.llm.synthesisOutputTokens,
          prompt,
        },
        (value) =>
          synthesis(
            aliases.expand(value),
            analyses,
            sourceMap,
            config.llm.summaryClaimLimit,
          ),
        usage,
      );
    try {
      result = await requestSynthesis(synthesisPrompt);
    } catch (error) {
      if (
        error instanceof WikiLlmResponseError &&
        error.stopReason === "max_tokens" &&
        error.responseText
      ) {
        const recovered = recoverTruncatedSynthesis(error.responseText);
        if (recovered !== undefined) {
          result = synthesis(
            aliases.expand(recovered),
            analyses,
            sourceMap,
            config.llm.summaryClaimLimit,
          );
        } else {
          throw error;
        }
      } else {
        if (
          !(error instanceof WikiLlmResponseError) ||
          (!error.message.includes("invalid schema") &&
            !error.message.includes("invalid JSON"))
        ) {
          throw error;
        }
        result = await requestSynthesis(
          error.responseText
            ? `Correct the following synthesis output to this exact JSON schema: {concepts:[{id,title,definition,claimIds}],claims:[{id,conceptIds}],contradictions:[{claimIds,description}],gaps:[{priority,description,searchQuery}]}. Claim IDs must come from: ${validClaimAliases.join(", ")}. Maximum 8 concepts, 16 claims, 8 contradictions, and 8 gaps. Validation error: ${error.message}. Return corrected JSON only.\nPrevious output:\n${error.responseText}`
            : `${synthesisPrompt}\nPrevious output failed validation: ${error.message}. Return corrected JSON only and use the supplied aliases exactly.`,
        );
      }
    }
  }
  if (!deferGlobalSynthesis && relevantSourceCount > 1 && !existingSynthesis)
    await writeText(synthesisCache, JSON.stringify(result, null, 2));

  // Synthesis aliases are not persistent claim identities.
  const registryId = (id: string) => {
    const value = registry.byAnalysisId.get(id);
    if (!value)
      throw new Error(`summary references unknown registry claim ${id}`);
    return value;
  };
  if (!resultUsesRegistryIds) {
    result = {
      ...result,
      concepts: result.concepts.map((concept) => ({
        ...concept,
        claimIds: concept.claimIds.map(registryId),
      })),
      claims: result.claims.map((claim) => ({
        ...claim,
        id: registryId(claim.id),
      })),
      contradictions: result.contradictions.map((contradiction) => ({
        ...contradiction,
        claimIds: contradiction.claimIds.map(registryId),
      })),
    };
  }
  // Deterministic quality derives from cached/persisted evidence only and
  // intentionally remains outside LLM cache keys.
  const quality = preliminaryQuality;
  const confidenceById = new Map<string, ClaimConfidence>(
    quality.claimConfidence.map((entry) => [entry.claimId, entry]),
  );
  const sourceScoreById = new Map(
    quality.sourceScores.map((entry) => [entry.sourceId, entry]),
  );
  const qualityCounts = {
    corroborated: quality.claimConfidence.filter(
      (entry) => entry.evidenceStatus === "corroborated",
    ).length,
    contested: quality.claimConfidence.filter(
      (entry) => entry.evidenceStatus === "contested",
    ).length,
    syntheticOnly: quality.claimConfidence.filter(
      (entry) => entry.evidenceStatus === "synthetic-only",
    ).length,
    averageConfidence: Math.round(
      quality.claimConfidence.reduce(
        (total, entry) => total + entry.confidence,
        0,
      ) / Math.max(1, quality.claimConfidence.length),
    ),
    averageSourceScore: Math.round(
      quality.sourceScores.reduce((total, entry) => total + entry.score, 0) /
        Math.max(1, quality.sourceScores.length),
    ),
  };
  for (const claim of registry.claims) {
    const confidence = confidenceById.get(claim.id)!;
    Object.assign(claim, {
      sourceScore: confidence.sourceScore,
      confidence: confidence.confidence,
      evidenceStatus: confidence.evidenceStatus,
      independentSupportSources: confidence.independentSupportSources,
      supportCount: confidence.supportCount,
      qualifyCount: confidence.qualifyCount,
      duplicateCount: confidence.duplicateCount,
      contradictionCount: confidence.contradictionCount,
    });
  }
  // Keep the LLM's topic-diverse membership intact, then make quality a
  // deterministic secondary ordering signal for the compatibility summary.
  result = {
    ...result,
    claims: [...result.claims].sort(
      (left, right) =>
        (confidenceById.get(right.id)?.confidence ?? 0) -
          (confidenceById.get(left.id)?.confidence ?? 0) ||
        left.id.localeCompare(right.id),
    ),
  };

  const wantedSources = new Set<string>();
  const wantedConcepts = new Set<string>();
  const wantedTopics = new Set<string>();
  const conceptFiles = new Map<string, string>();
  const usedConceptFiles = new Set<string>();
  for (const concept of result.concepts) {
    const base = slugify(concept.title) || slugify(concept.id);
    let filename = `${base}.md`;
    if (usedConceptFiles.has(filename)) {
      filename = `${base}-${slugify(concept.id)}.md`;
    }
    usedConceptFiles.add(filename);
    conceptFiles.set(concept.id, filename);
  }
  let pagesWritten = 0;
  for (const source of sourceList) {
    const analysis = analyses.get(source.id)!;
    const filename = `${slugify(source.title)}-${source.id.slice(0, 8)}.md`;
    const target = path.join(config.wikiDir, "sources", filename);
    wantedSources.add(target);
    const provenance = source.provenanceHistory
      .map((entry, index) =>
        [
          `### ${index + 1}. ${entry.kind}`,
          `- Input: \`${entry.input.replace(/`/g, "'")}\``,
          entry.url ? `- URL: \`${entry.url.replace(/`/g, "'")}\`` : "",
          entry.provider
            ? `- Provider: \`${entry.provider.replace(/`/g, "'")}\``
            : "",
          entry.storageUri
            ? `- Storage URI: \`${entry.storageUri.replace(/`/g, "'")}\``
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n");
    const evidence = analysis.claims
      .map(
        (claim) =>
          `- \`${claim.id}\`: chunk ${claim.locator.chunkIndex + 1} (\`${claim.locator.chunkId.slice(0, 12)}\`), offsets ${claim.locator.start}-${claim.locator.end}${claim.locator.section ? `, section “${claim.locator.section}”` : ""}${claim.locator.page === undefined ? "" : `, page ${claim.locator.page}`}`,
      )
      .join("\n");
    const rejectedEvidence = analysis.rejectedClaims
      .map((claim) => `- ${claim}`)
      .join("\n");
    const sourceScore = sourceScoreById.get(source.id)!;
    const qualitySummary = `## Source quality

- Score: **${sourceScore.score}/100**
- Evidence class: ${sourceScore.evidenceClass}
- Components: ${Object.entries(sourceScore.components)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ")}
${sourceScore.positiveReasons.map((reason) => `- Strength: ${reason}`).join("\n")}
${sourceScore.penalties.map((penalty) => `- Warning: ${penalty}`).join("\n")}${sourceScore.evidenceClass === "synthetic-experiment" ? "\n- **Synthetic evidence warning:** explicitly synthetic evidence is not production-grade evidence." : ""}`;
    const body = `# ${source.title}\n\n${qualitySummary}\n\n## LLM summary\n\n${analysis.summary ? markdownProse(analysis.summary) : "_Not summarized because this source was excluded from synthesis._"}\n\n## Scope\n\n${analysis.relevant ? "Included in synthesis." : `Excluded from synthesis: ${markdownProse(analysis.exclusionReason)}`}\n\n## Provenance\n\n- Source ID: \`${source.id}\`\n- SHA-256: \`${source.hash}\`\n- Media type: \`${source.mediaType}\`\n- Ingested at: \`${source.ingestedAt}\`\n- Current origin: \`${source.provenance.input.replace(/`/g, "'")}\`\n\n## Evidence locators\n\n${evidence || "_No validated evidence claims._"}\n\n## Rejected LLM claims\n\n${rejectedEvidence || "_None._"}\n\n## Provenance history\n\n${provenance}\n\n## Source text\n\n${source.content}`;
    await writeText(
      target,
      generatedDocument(
        {
          title: source.title,
          slug: `${slugify(source.title).slice(0, 70)}-${source.id.slice(0, 8)}`,
          generated: "true",
          type: "source",
          source_id: source.id,
          source_hash: source.hash,
          provenance_kind: source.provenance.kind,
          provenance_input: source.provenance.input,
        },
        body,
        await readTextIfExists(target),
      ),
    );
    pagesWritten++;
  }
  for (const topic of topics) {
    const target = path.join(config.wikiDir, "topics", `${topic.id}.md`);
    wantedTopics.add(target);
    const claims = topic.claimIds.map((id) => registryById.get(id)!);
    const rows = claims.map((claim) => {
      const source = sourceMap.get(claim.sourceId)!;
      const locator = claim.locator;
      return `- \`${claim.id}\` — **${claim.confidence}/100, ${claim.evidenceStatus}**: ${markdownProse(claim.statement)}\n  - Evidence: “${markdownProse(claim.quote)}” — [[../sources/${slugify(source.title)}-${source.id.slice(0, 8)}.md|${source.title}]] (chunk ${locator.chunkIndex + 1}, offsets ${locator.start}-${locator.end}${locator.section ? `, ${locator.section}` : ""}${locator.page === undefined ? "" : `, p. ${locator.page}`})`;
    });
    await writeText(
      target,
      generatedDocument(
        {
          title: topic.title,
          slug: topic.id,
          generated: "true",
          type: "topic",
          claim_count: String(topic.claimIds.length),
        },
        `# ${topic.title}\n\n## Overview\n\n${topic.overview ? markdownProse(topic.overview) : "_No LLM overview was supplied; the evidence below defines this deterministic topic._"}\n\n## Concepts\n\n${topic.conceptLabels?.map((label) => `- ${markdownProse(label)}`).join("\n") || "_None._"}\n\n## Summary claim IDs\n\n${topic.summaryClaimIds?.map((id) => `- \`${id}\``).join("\n") || "_None._"}\n\n## Evidence-backed registry claims\n\n${rows.join("\n") || "_No claims._"}`,
        await readTextIfExists(target),
      ),
    );
    pagesWritten++;
  }
  for (const concept of result.concepts) {
    const target = path.join(
      config.wikiDir,
      "concepts",
      conceptFiles.get(concept.id)!,
    );
    wantedConcepts.add(target);
    const rows = concept.claimIds.map((claimId) => {
      const claim = registryById.get(claimId)!;
      const source = sourceMap.get(claim.sourceId)!;
      const locator = claim.locator;
      const registryClaim = registryById.get(claimId)!;
      return `- **${registryClaim.confidence}/100, ${registryClaim.evidenceStatus}**: ${markdownProse(claim.text)}\n  - Evidence: “${markdownProse(claim.quote)}” — [[../sources/${slugify(source.title)}-${source.id.slice(0, 8)}.md|${source.title}]] (chunk ${locator.chunkIndex + 1}, offsets ${locator.start}-${locator.end}${locator.section ? `, ${locator.section}` : ""}${locator.page === undefined ? "" : `, p. ${locator.page}`})`;
    });
    const provenance = [
      ...new Set(concept.claimIds.map((id) => registryById.get(id)!.sourceId)),
    ];
    await writeText(
      target,
      generatedDocument(
        {
          title: concept.title,
          slug: slugify(concept.id),
          generated: "true",
          type: "concept",
          provenance,
        },
        `# ${concept.title}\n\n## Definition\n\n${markdownProse(concept.definition)}\n\n## Evidence-backed claims\n\n${rows.join("\n") || "_No validated claims._"}`,
        await readTextIfExists(target),
      ),
    );
    pagesWritten++;
  }
  await removeStaleGenerated(
    path.join(config.wikiDir, "sources"),
    wantedSources,
  );
  await removeStaleGenerated(
    path.join(config.wikiDir, "concepts"),
    wantedConcepts,
  );
  await removeStaleGenerated(path.join(config.wikiDir, "topics"), wantedTopics);
  const gapsPath = path.join(config.metaDir, "gaps.json");
  const existingGaps = await readTextIfExists(gapsPath);
  if (result.gaps.length > 0 || existingGaps === undefined) {
    await writeText(
      gapsPath,
      JSON.stringify({ version: 1, gaps: result.gaps }, null, 2),
    );
    await writeText(
      path.join(config.metaDir, "gaps.md"),
      `# Knowledge gaps\n\n${result.gaps.map((gap) => `- P${gap.priority}: ${gap.description}\n  - Search query: \`${gap.searchQuery}\``).join("\n") || "_No gaps identified._"}`,
    );
  }
  const graphPath = path.join(config.metaDir, "knowledge_graph.json");
  const claimsPath = path.join(config.metaDir, "claims.json");
  const rejectedClaimsPath = path.join(config.metaDir, "rejected_claims.json");
  const claimGraphPath = path.join(config.metaDir, "claim_graph.json");
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  await writeText(
    path.join(config.metaDir, "source_scores.json"),
    JSON.stringify(
      {
        version: 1,
        generatedAt,
        formula:
          "content + identifiers + metadata + logarithmically bounded citations + OA/license + provider diversity + recency + provenance; explicit synthetic and metadata-only caps apply",
        sources: quality.sourceScores,
      },
      null,
      2,
    ),
  );
  await writeText(
    path.join(config.metaDir, "claim_confidence.json"),
    JSON.stringify(
      {
        version: 1,
        generatedAt,
        formula:
          "0.65 × source score + distinct-source corroboration + qualify/duplicate bonuses − contradiction penalties, with single-source, synthetic-only, and insufficient-evidence caps",
        claims: quality.claimConfidence,
      },
      null,
      2,
    ),
  );
  await writeText(
    claimsPath,
    JSON.stringify(
      {
        version: 1,
        model,
        researchFocus: config.researchFocus,
        generatedAt,
        acceptedCount: registry.claims.length,
        rejectedCount: registry.rejectedClaims.length,
        sources: sourceList.map((source) => ({
          id: source.id,
          title: source.title,
          path: `wiki/sources/${slugify(source.title)}-${source.id.slice(0, 8)}.md`,
          ...(source.literature ? { literature: source.literature } : {}),
        })),
        topics,
        claims: registry.claims,
      },
      null,
      2,
    ),
  );
  await writeText(
    rejectedClaimsPath,
    JSON.stringify(
      {
        version: 1,
        generatedAt,
        rejectedCount: registry.rejectedClaims.length,
        claims: registry.rejectedClaims,
      },
      null,
      2,
    ),
  );
  await writeText(
    claimGraphPath,
    JSON.stringify(
      {
        version: 1,
        generatedAt,
        nodes: registry.claims.map((claim) => ({
          id: claim.id,
          sourceId: claim.sourceId,
          status: claim.status,
          topicIds: claim.topicIds,
        })),
        edges: relationshipEdges,
        relationshipCount: relationshipEdges.length,
        contradictionCount: relationshipEdges.filter(
          (edge) => edge.type === "contradicts",
        ).length,
      },
      null,
      2,
    ),
  );
  await writeText(
    graphPath,
    JSON.stringify(
      {
        version: 3,
        provider: provider.name,
        model,
        sources: sourceList.map((s) => ({
          id: s.id,
          relevant: analyses.get(s.id)!.relevant,
          path: `wiki/sources/${slugify(s.title)}-${s.id.slice(0, 8)}.md`,
          title: s.title,
          chunks: (chunksBySource.get(s.id) ?? []).map((chunk) => ({
            id: chunk.id,
            hash: chunk.hash,
            index: chunk.index,
            start: chunk.start,
            end: chunk.end,
            ...(chunk.section ? { section: chunk.section } : {}),
            ...(chunk.page === undefined ? {} : { page: chunk.page }),
          })),
        })),
        concepts: result.concepts,
        conceptPages: result.concepts.map((concept) => ({
          id: concept.id,
          path: `wiki/concepts/${conceptFiles.get(concept.id)!}`,
        })),
        // Compatibility graph: selected summary only. claims.json is complete.
        claims: result.claims,
        summaryClaims: result.claims,
        registryCount: registry.claims.length,
        summaryClaimCount: result.claims.length,
        topics: topics.map((topic) => ({
          id: topic.id,
          title: topic.title,
          path: `wiki/topics/${topic.id}.md`,
          claimCount: topic.claimIds.length,
        })),
        topicCount: topics.length,
        relationshipCount: relationshipEdges.length,
        contradictionCount: relationshipEdges.filter(
          (edge) => edge.type === "contradicts",
        ).length,
        quality: qualityCounts,
        // Full-registry relationships are authoritative; summary contradictions
        // are preserved separately for compatibility consumers.
        relationships: relationshipEdges,
        contradictions: relationshipEdges
          .filter((edge) => edge.type === "contradicts")
          .map((edge) => ({
            claimIds: [edge.from, edge.to],
            description: edge.explanation,
          })),
        summaryContradictions: result.contradictions,
      },
      null,
      2,
    ),
  );
  const adjudications = await loadContradictionAdjudications(config.metaDir);
  await writeQualityPages(
    config.wikiDir,
    quality,
    registry.claims,
    relationshipEdges,
    adjudications,
  );
  await writeText(
    path.join(config.wikiDir, "index.md"),
    `# Knowledge index\n\n## Sources (${sourceList.length})\n\n${sourceList.map((source) => `- [[sources/${slugify(source.title)}-${source.id.slice(0, 8)}.md|${source.title}]] — ${analyses.get(source.id)!.relevant ? "included" : "excluded from synthesis"}`).join("\n") || "_No sources ingested._"}\n\n## Concepts (${result.concepts.length})\n\n${result.concepts.map((concept) => `- [[concepts/${conceptFiles.get(concept.id)!}|${concept.title}]]`).join("\n") || "_No synthesized concepts._"}\n\n## Topics (${topics.length})\n\n${topics.map((topic) => `- [[topics/${topic.id}.md|${topic.title}]] (${topic.claimIds.length} claims)`).join("\n") || "_No topics._"}\n\n## Quality\n\n- Corroborated claims: ${qualityCounts.corroborated}\n- Contested claims: ${qualityCounts.contested}\n- Synthetic-only claims: ${qualityCounts.syntheticOnly}\n- Average claim confidence: ${qualityCounts.averageConfidence}/100\n- Average source score: ${qualityCounts.averageSourceScore}/100\n\n## Summary claims (${result.claims.length})\n\nThis compatibility summary selects ${result.claims.length} claims from ${registry.claims.length} accepted registry claims. The complete evidence registry is \`meta/claims.json\`.`,
  );
  const totalUsage = usage.result();
  await writeText(
    path.join(config.metaDir, "capabilities.json"),
    JSON.stringify(
      {
        sourceCount: sourceList.length,
        conceptCount: result.concepts.length,
        claimCount: result.claims.length,
        registryCount: registry.claims.length,
        summaryClaimCount: result.claims.length,
        topicCount: topics.length,
        relationshipCount: relationshipEdges.length,
        contradictionCount: relationshipEdges.filter(
          (edge) => edge.type === "contradicts",
        ).length,
        provider: provider.name,
        quality: qualityCounts,
        model,
        llm: true,
        globalSynthesis: !deferGlobalSynthesis,
        evidenceSourceCount,
        lastGlobalSynthesisEvidenceSourceCount: deferGlobalSynthesis
          ? lastGlobalSynthesisEvidenceSourceCount
          : evidenceSourceCount,
        lastCompileUsage: totalUsage,
      },
      null,
      2,
    ),
  );
  await writeText(
    path.join(config.metaDir, "capability_map.md"),
    `# Capability map\n\n## Knowledge metrics\n\n- Processed sources: ${sourceList.length}\n- Synthesized concepts: ${result.concepts.length}\n- Accepted registry claims: ${registry.claims.length}\n- Summary claims: ${result.claims.length}\n- Corroborated claims: ${qualityCounts.corroborated}\n- Contested claims: ${qualityCounts.contested}\n- Synthetic-only claims: ${qualityCounts.syntheticOnly}\n- Average claim confidence: ${qualityCounts.averageConfidence}/100\n- Average source score: ${qualityCounts.averageSourceScore}/100\n\n## LLM configuration\n\n- Provider: ${provider.name}\n- Model: ${model}\n- Research focus: ${config.researchFocus || "_not specified_"}`,
  );
  const now = (options.now ?? (() => new Date()))().toISOString();
  const logPath = path.join(config.wikiDir, "log.md");
  const log = (await readTextIfExists(logPath)) ?? "# Compilation log\n";
  await writeText(
    logPath,
    `${log.trimEnd()}\n\n- ${now}: LLM compiled ${sourceList.length} sources, ${result.concepts.length} concepts, ${registry.claims.length} registry claims, and ${result.claims.length} summary claims; global synthesis=${!deferGlobalSynthesis} (input tokens=${totalUsage.inputTokens}, output tokens=${totalUsage.outputTokens}).`,
  );
  return {
    sources: sourceList.length,
    concepts: result.concepts.length,
    pagesWritten,
    graphPath,
    gapsPath,
    claimsPath,
    registryCount: registry.claims.length,
    summaryClaimCount: result.claims.length,
    topicCount: topics.length,
    claimGraphPath,
    relationshipCount: relationshipEdges.length,
    contradictionCount: relationshipEdges.filter(
      (edge) => edge.type === "contradicts",
    ).length,
    globalSynthesis: !deferGlobalSynthesis,
    usage: totalUsage,
  };
}
