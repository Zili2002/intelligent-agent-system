import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { semanticContentHash } from "./semantic-index.js";
import type { ServiceOptions } from "./types.js";
import { walkFiles } from "./utils.js";

export interface WikiStatus {
  root: string;
  sourceArtifacts: number;
  wikiPages: number;
  reflections: number;
  registryClaims: number;
  summaryClaims: number;
  topics: number;
  relationships: number;
  contradictions: number;
  adjudicatedContradictions: number;
  pendingAdjudications: number;
  semanticIndexedClaims: number;
  semanticStaleClaims: number;
  semanticModel?: string;
  retrievalRecallAt10?: number;
  retrievalCitationValidity?: number;
  frontierItems: number;
  frontierPending: number;
  frontierRunning: number;
  frontierDeferred: number;
  frontierCapacity: number;
  frontierActiveItems: number;
  frontierOccupancyPercent: number;
  frontierAdmissionMode: "normal" | "throttled" | "critical";
  frontierHistoryItems: number;
  frontierSemanticDeduplicated: number;
  frontierCompacted: number;
  frontierCircuitBroken: number;
  lifecycleRetractedClaims: number;
  lifecycleVersionReviewClaims: number;
  lifecycleSupersededClaims: number;
  lastRefreshAt?: string;
  corroborated: number;
  contested: number;
  syntheticOnly: number;
  averageConfidence: number;
  averageSourceScore: number;
  autoCommit: boolean;
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

export async function getStatus(
  options: ServiceOptions = {},
): Promise<WikiStatus> {
  const config = await loadConfig(options.root);
  const [
    sources,
    pages,
    reflections,
    registry,
    claimGraph,
    summaryGraph,
    confidence,
    sourceScores,
    adjudications,
    semanticIndex,
    retrievalEvaluation,
    frontier,
    lifecycle,
    lifecycleState,
  ] = await Promise.all([
    walkFiles(config.sourcesDir, ".json"),
    walkFiles(config.wikiDir, ".md"),
    walkFiles(path.join(config.metaDir, "reflection"), ".md"),
    readJson(path.join(config.metaDir, "claims.json")),
    readJson(path.join(config.metaDir, "claim_graph.json")),
    readJson(path.join(config.metaDir, "knowledge_graph.json")),
    readJson(path.join(config.metaDir, "claim_confidence.json")),
    readJson(path.join(config.metaDir, "source_scores.json")),
    readJson(path.join(config.metaDir, "contradiction_adjudications.json")),
    readJson(path.join(config.metaDir, "semantic_index.json")),
    readJson(path.join(config.metaDir, "retrieval_evaluation.json")),
    readJson(path.join(config.metaDir, "evidence_frontier.json")),
    readJson(path.join(config.metaDir, "knowledge_lifecycle.json")),
    readJson(path.join(config.metaDir, "lifecycle_state.json")),
  ]);
  const registryClaims = Array.isArray(registry.claims)
    ? registry.claims.length
    : 0;
  const topics = Array.isArray(registry.topics) ? registry.topics.length : 0;
  const edges = Array.isArray(claimGraph.edges) ? claimGraph.edges : [];
  const summaryClaims = Array.isArray(summaryGraph.claims)
    ? summaryGraph.claims.length
    : 0;
  const contradictionCount = edges.filter(
    (edge) =>
      edge &&
      typeof edge === "object" &&
      !Array.isArray(edge) &&
      (edge as Record<string, unknown>).type === "contradicts",
  ).length;
  const adjudicatedContradictions = Array.isArray(adjudications.adjudications)
    ? adjudications.adjudications.length
    : 0;
  const semanticEntries = Array.isArray(semanticIndex.claims)
    ? semanticIndex.claims.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          typeof (entry as Record<string, unknown>).claimId === "string" &&
          typeof (entry as Record<string, unknown>).contentHash === "string",
      )
    : [];
  const semanticHashes = new Map(
    semanticEntries.map((entry) => [
      entry.claimId as string,
      entry.contentHash as string,
    ]),
  );
  const semanticStaleClaims = Array.isArray(registry.claims)
    ? registry.claims.filter((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item))
          return true;
        const claim = item as Record<string, unknown>;
        if (
          typeof claim.id !== "string" ||
          typeof claim.statement !== "string" ||
          typeof claim.quote !== "string"
        ) {
          return true;
        }
        return (
          semanticHashes.get(claim.id) !==
          semanticContentHash(
            {
              id: claim.id,
              statement: claim.statement,
              quote: claim.quote,
              sourceTitle:
                typeof claim.sourceTitle === "string" ? claim.sourceTitle : "",
              topicIds: Array.isArray(claim.topicIds)
                ? claim.topicIds.filter(
                    (topic): topic is string => typeof topic === "string",
                  )
                : [],
            },
            typeof semanticIndex.passagePrefix === "string"
              ? semanticIndex.passagePrefix
              : "",
          )
        );
      }).length
    : 0;
  const frontierItems = Array.isArray(frontier.items)
    ? frontier.items.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
  const frontierCount = (status: string) =>
    frontierItems.filter((item) => item.status === status).length;
  const frontierActiveItems =
    frontierCount("pending") +
    frontierCount("running") +
    frontierCount("deferred");
  const frontierOccupancyPercent =
    Math.round(
      (frontierActiveItems / config.lifecycle.maxFrontierItems) * 10_000,
    ) / 100;
  const frontierAdmissionMode =
    frontierOccupancyPercent >= config.lifecycle.criticalWatermarkPercent
      ? "critical"
      : frontierOccupancyPercent >= config.lifecycle.highWatermarkPercent
        ? "throttled"
        : "normal";
  const frontierCounters =
    frontier.counters &&
    typeof frontier.counters === "object" &&
    !Array.isArray(frontier.counters)
      ? (frontier.counters as Record<string, unknown>)
      : {};
  const lifecycleClaims = Array.isArray(lifecycle.claims)
    ? lifecycle.claims.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
  const confidenceClaims = Array.isArray(confidence.claims)
    ? confidence.claims.filter(
        (claim): claim is Record<string, unknown> =>
          Boolean(claim) && typeof claim === "object" && !Array.isArray(claim),
      )
    : [];
  const scoredSources = Array.isArray(sourceScores.sources)
    ? sourceScores.sources.filter(
        (source): source is Record<string, unknown> =>
          Boolean(source) &&
          typeof source === "object" &&
          !Array.isArray(source),
      )
    : [];
  const statusCount = (status: string) =>
    confidenceClaims.filter((claim) => claim.evidenceStatus === status).length;
  const average = (items: Record<string, unknown>[], key: string) =>
    Math.round(
      items.reduce(
        (total, item) =>
          total + (typeof item[key] === "number" ? item[key] : 0),
        0,
      ) / Math.max(1, items.length),
    );
  return {
    root: config.root,
    sourceArtifacts: sources.length,
    wikiPages: pages.length,
    reflections: reflections.filter(
      (file) => path.basename(file).toLowerCase() !== "readme.md",
    ).length,
    registryClaims,
    summaryClaims,
    topics,
    relationships: edges.length,
    contradictions: contradictionCount,
    adjudicatedContradictions,
    pendingAdjudications: Math.max(
      0,
      contradictionCount - adjudicatedContradictions,
    ),
    semanticIndexedClaims: semanticEntries.length,
    semanticStaleClaims,
    ...(typeof semanticIndex.model === "string"
      ? { semanticModel: semanticIndex.model }
      : {}),
    ...(typeof retrievalEvaluation.recallAt10 === "number"
      ? { retrievalRecallAt10: retrievalEvaluation.recallAt10 }
      : {}),
    ...(typeof retrievalEvaluation.citationValidity === "number"
      ? {
          retrievalCitationValidity: retrievalEvaluation.citationValidity,
        }
      : {}),
    frontierItems: frontierItems.length,
    frontierPending: frontierCount("pending"),
    frontierRunning: frontierCount("running"),
    frontierDeferred: frontierCount("deferred"),
    frontierCapacity: config.lifecycle.maxFrontierItems,
    frontierActiveItems,
    frontierOccupancyPercent,
    frontierAdmissionMode,
    frontierHistoryItems: Array.isArray(frontier.history)
      ? frontier.history.length
      : 0,
    frontierSemanticDeduplicated:
      typeof frontierCounters.semanticDeduplicated === "number"
        ? frontierCounters.semanticDeduplicated
        : 0,
    frontierCompacted:
      typeof frontierCounters.compacted === "number"
        ? frontierCounters.compacted
        : 0,
    frontierCircuitBroken:
      typeof frontierCounters.circuitBroken === "number"
        ? frontierCounters.circuitBroken
        : 0,
    lifecycleRetractedClaims: lifecycleClaims.filter(
      (claim) => claim.status === "retracted-source",
    ).length,
    lifecycleVersionReviewClaims: lifecycleClaims.filter(
      (claim) => claim.status === "version-review-required",
    ).length,
    lifecycleSupersededClaims: lifecycleClaims.filter(
      (claim) => claim.status === "superseded-source",
    ).length,
    ...(typeof lifecycleState.lastRefreshAt === "string"
      ? { lastRefreshAt: lifecycleState.lastRefreshAt }
      : {}),
    corroborated: statusCount("corroborated"),
    contested: statusCount("contested"),
    syntheticOnly: statusCount("synthetic-only"),
    averageConfidence: average(confidenceClaims, "confidence"),
    averageSourceScore: average(scoredSources, "score"),
    autoCommit: config.autoCommit,
  };
}
