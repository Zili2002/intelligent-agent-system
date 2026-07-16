import path from "node:path";
import { cleanModel, LlmUsageTracker, requestJson, requireLlm } from "./llm.js";
import {
  writeQualityPages,
  type ClaimConfidence,
  type QualityArtifacts,
  type QualityClaim,
  type QualityEdge,
  type SourceScore,
} from "./quality.js";
import { loadConfig } from "./config.js";
import type {
  AdjudicationResult,
  ContradictionAdjudication,
  ContradictionResolution,
  ServiceOptions,
} from "./types.js";
import { mapConcurrent, readTextIfExists, sha256, writeText } from "./utils.js";

const ADJUDICATION_VERSION = 2;
const RESOLUTIONS = new Set<ContradictionResolution>([
  "unresolved",
  "context-dependent",
  "evidence-favors-from",
  "evidence-favors-to",
  "insufficient-evidence",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string, maximum = 4_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function stringArray(value: unknown, label: string, maximum = 16): string[] {
  if (typeof value === "string") {
    return [requiredText(value, label, 1_000)];
  }
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((item, index) =>
    requiredText(item, `${label}[${index}]`, 1_000),
  );
}

function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

function validateAdjudications(
  value: unknown,
  expected: Array<{ from: string; to: string; allowedClaims: Set<string> }>,
  requireAll = true,
): ContradictionAdjudication[] {
  const data = record(value, "adjudication");
  if (!Array.isArray(data.adjudications)) {
    throw new Error("adjudication.adjudications must be an array");
  }
  const expectedByKey = new Map(
    expected.map((item) => [edgeKey(item.from, item.to), item]),
  );
  const output = data.adjudications.map((item, index) => {
    const entry = record(item, `adjudications[${index}]`);
    const from = requiredText(entry.from, `adjudications[${index}].from`, 120);
    const to = requiredText(entry.to, `adjudications[${index}].to`, 120);
    const expectedEntry = expectedByKey.get(edgeKey(from, to));
    if (!expectedEntry) {
      throw new Error("adjudication references an unknown contradiction");
    }
    if (
      typeof entry.resolution !== "string" ||
      !RESOLUTIONS.has(entry.resolution as ContradictionResolution)
    ) {
      throw new Error("adjudication resolution is invalid");
    }
    const evidenceClaimIds = stringArray(
      entry.evidenceClaimIds,
      `adjudications[${index}].evidenceClaimIds`,
    );
    if (evidenceClaimIds.some((id) => !expectedEntry.allowedClaims.has(id))) {
      throw new Error("adjudication references evidence not supplied to it");
    }
    return {
      from,
      to,
      resolution: entry.resolution as ContradictionResolution,
      rationale: requiredText(
        entry.rationale,
        `adjudications[${index}].rationale`,
      ),
      evidenceClaimIds,
      evidenceNeeds: stringArray(
        entry.evidenceNeeds,
        `adjudications[${index}].evidenceNeeds`,
      ),
    };
  });
  const uniqueCount = new Set(output.map((item) => edgeKey(item.from, item.to)))
    .size;
  if (
    !output.length ||
    uniqueCount !== output.length ||
    (requireAll && output.length !== expected.length)
  ) {
    throw new Error(
      "adjudication must return every contradiction exactly once",
    );
  }
  return output;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  const content = await readTextIfExists(file);
  if (!content) throw new Error(`Required artifact is missing: ${file}`);
  return record(JSON.parse(content), file);
}

export async function loadContradictionAdjudications(
  metaDir: string,
): Promise<ContradictionAdjudication[]> {
  const content = await readTextIfExists(
    path.join(metaDir, "contradiction_adjudications.json"),
  );
  if (!content) return [];
  const data = record(JSON.parse(content), "contradiction adjudications");
  if (!Array.isArray(data.adjudications)) return [];
  return data.adjudications.map((item) => {
    const entry = record(item, "contradiction adjudication");
    const resolution = entry.resolution;
    if (
      typeof resolution !== "string" ||
      !RESOLUTIONS.has(resolution as ContradictionResolution)
    ) {
      throw new Error("Stored contradiction adjudication is invalid");
    }
    return {
      from: requiredText(entry.from, "adjudication.from", 120),
      to: requiredText(entry.to, "adjudication.to", 120),
      resolution: resolution as ContradictionResolution,
      rationale: requiredText(entry.rationale, "adjudication.rationale"),
      evidenceClaimIds: stringArray(
        entry.evidenceClaimIds,
        "adjudication.evidenceClaimIds",
      ),
      evidenceNeeds: stringArray(
        entry.evidenceNeeds,
        "adjudication.evidenceNeeds",
      ),
    };
  });
}

export async function adjudicateWiki(
  options: ServiceOptions = {},
): Promise<AdjudicationResult> {
  const config = await loadConfig(options.root);
  const registry = await readJson(path.join(config.metaDir, "claims.json"));
  const graph = await readJson(path.join(config.metaDir, "claim_graph.json"));
  const confidenceData = await readJson(
    path.join(config.metaDir, "claim_confidence.json"),
  );
  const scoreData = await readJson(
    path.join(config.metaDir, "source_scores.json"),
  );
  if (
    !Array.isArray(registry.claims) ||
    !Array.isArray(registry.sources) ||
    !Array.isArray(graph.edges) ||
    !Array.isArray(confidenceData.claims) ||
    !Array.isArray(scoreData.sources)
  ) {
    throw new Error("Malformed compiled evidence artifacts");
  }
  const claims = registry.claims.map((item, index) => {
    const claim = record(item, `claims[${index}]`);
    return {
      id: requiredText(claim.id, `claims[${index}].id`, 120),
      sourceId: requiredText(claim.sourceId, `claims[${index}].sourceId`, 120),
      statement: requiredText(
        claim.statement,
        `claims[${index}].statement`,
        8_000,
      ),
      quote: requiredText(claim.quote, `claims[${index}].quote`, 8_000),
      ...(claim.locator === undefined ? {} : { locator: claim.locator }),
      ...(typeof claim.sourceTitle === "string"
        ? { sourceTitle: claim.sourceTitle }
        : {}),
      ...(typeof claim.sourcePath === "string"
        ? { sourcePath: claim.sourcePath }
        : {}),
    } satisfies QualityClaim;
  });
  const edges = graph.edges.map((item, index) => {
    const edge = record(item, `edges[${index}]`);
    const type = requiredText(edge.type, `edges[${index}].type`, 40);
    if (!["supports", "contradicts", "qualifies", "duplicate"].includes(type)) {
      throw new Error(`edges[${index}].type is invalid`);
    }
    return {
      from: requiredText(edge.from, `edges[${index}].from`, 120),
      to: requiredText(edge.to, `edges[${index}].to`, 120),
      type: type as QualityEdge["type"],
      explanation: requiredText(
        edge.explanation,
        `edges[${index}].explanation`,
      ),
    };
  });
  const contradictions = edges.filter((edge) => edge.type === "contradicts");
  const artifactPath = path.join(
    config.metaDir,
    "contradiction_adjudications.json",
  );
  if (!contradictions.length) {
    await writeText(
      artifactPath,
      JSON.stringify(
        {
          version: ADJUDICATION_VERSION,
          generatedAt: (options.now?.() ?? new Date()).toISOString(),
          adjudications: [],
        },
        null,
        2,
      ),
    );
    return { artifactPath, adjudications: [], usage: {} };
  }
  const provider = requireLlm(config, options);
  const tracker = new LlmUsageTracker(options.maxLlmTokens);
  const model = cleanModel(process.env.ANTHROPIC_MODEL ?? config.llm.model);
  const byClaim = new Map(claims.map((claim) => [claim.id, claim]));
  const confidence = new Map(
    (confidenceData.claims as ClaimConfidence[]).map((item) => [
      item.claimId,
      item,
    ]),
  );
  const scores = new Map(
    (scoreData.sources as SourceScore[]).map((item) => [item.sourceId, item]),
  );
  const batches = Array.from(
    { length: Math.ceil(contradictions.length / 12) },
    (_, index) => contradictions.slice(index * 12, (index + 1) * 12),
  );
  const batchResults = await mapConcurrent(
    batches,
    config.llm.adjudicationConcurrency,
    async (batch) => {
      const expected = batch.map((edge) => {
        const related = edges
          .filter(
            (candidate) =>
              candidate.type !== "contradicts" &&
              [candidate.from, candidate.to].some(
                (id) => id === edge.from || id === edge.to,
              ),
          )
          .flatMap((candidate) => [candidate.from, candidate.to])
          .filter((id) => id !== edge.from && id !== edge.to)
          .slice(0, 6);
        return {
          from: edge.from,
          to: edge.to,
          allowedClaims: new Set([edge.from, edge.to, ...related]),
        };
      });
      const batchAllowedClaims = new Set(
        expected.flatMap((item) => [...item.allowedClaims]),
      );
      for (const item of expected) item.allowedClaims = batchAllowedClaims;
      const claimsInput = [...batchAllowedClaims].map((id) => {
        const claim = byClaim.get(id);
        if (!claim)
          throw new Error(`Claim graph references unknown Claim ${id}`);
        const claimConfidence = confidence.get(id);
        return {
          id,
          statement: claim.statement,
          quote: claim.quote,
          sourceId: claim.sourceId,
          sourceScore: scores.get(claim.sourceId)?.score ?? 0,
          confidence: claimConfidence?.confidence ?? 0,
          evidenceStatus: claimConfidence?.evidenceStatus ?? "insufficient",
        };
      });
      const contradictionsFor = (
        entries: Array<{
          from: string;
          to: string;
          allowedClaims: Set<string>;
        }>,
      ) =>
        entries.map((item) => ({
          from: item.from,
          to: item.to,
          relationshipExplanation: batch.find(
            (edge) => edge.from === item.from && edge.to === item.to,
          )!.explanation,
        }));
      const input = {
        claims: claimsInput,
        contradictions: contradictionsFor(expected),
      };
      const cacheKey = sha256(
        JSON.stringify({
          version: ADJUDICATION_VERSION,
          model,
          focus: config.researchFocus,
          input,
        }),
      );
      const cache = path.join(
        config.metaDir,
        "contradiction-adjudication",
        `${cacheKey}.json`,
      );
      const cached = await readTextIfExists(cache);
      let batchResult: ContradictionAdjudication[];
      if (cached) {
        batchResult = validateAdjudications(JSON.parse(cached), expected);
      } else {
        batchResult = [];
        let pending = expected;
        while (pending.length) {
          const pendingInput = {
            claims: claimsInput,
            contradictions: contradictionsFor(pending),
          };
          const partial = await requestJson(
            provider,
            {
              purpose: "contradiction-adjudication",
              maxTokens: Math.min(config.llm.synthesisOutputTokens, 8_000),
              prompt: `Adjudicate each supplied contradiction for "${config.researchFocus}" using only the top-level immutable claims dictionary and quality signals. Return JSON {adjudications:[{from,to,resolution,rationale,evidenceClaimIds,evidenceNeeds}]}. resolution must be unresolved, context-dependent, evidence-favors-from, evidence-favors-to, or insufficient-evidence. Do not infer truth from citation counts or confidence alone. Use context-dependent only when scope or conditions reconcile the claims. evidenceClaimIds may contain only IDs from claims. Return every contradiction pair exactly once.\n${JSON.stringify(pendingInput)}`,
            },
            (value) => validateAdjudications(value, pending, false),
            tracker,
          );
          batchResult.push(...partial);
          const returned = new Set(
            partial.map((item) => edgeKey(item.from, item.to)),
          );
          pending = pending.filter(
            (item) => !returned.has(edgeKey(item.from, item.to)),
          );
        }
        validateAdjudications({ adjudications: batchResult }, expected);
      }
      if (!cached) {
        await writeText(
          cache,
          JSON.stringify({ adjudications: batchResult }, null, 2),
        );
      }
      return batchResult;
    },
  );
  const adjudications = batchResults.flat();
  await writeText(
    artifactPath,
    JSON.stringify(
      {
        version: ADJUDICATION_VERSION,
        model,
        researchFocus: config.researchFocus,
        generatedAt: (options.now?.() ?? new Date()).toISOString(),
        adjudications,
      },
      null,
      2,
    ),
  );
  const quality: QualityArtifacts = {
    sourceScores: scoreData.sources as SourceScore[],
    claimConfidence: confidenceData.claims as ClaimConfidence[],
  };
  await writeQualityPages(
    config.wikiDir,
    quality,
    claims,
    edges,
    adjudications,
  );
  return {
    artifactPath,
    adjudications,
    usage: tracker.result(),
  };
}
