import { readFile } from "node:fs/promises";
import path from "node:path";
import { compileWiki } from "./compile.js";
import { loadConfig } from "./config.js";
import { enrichOpenAlex } from "./enrich-openalex.js";
import { evaluateRetrieval } from "./evaluate.js";
import {
  admitEvidenceClues,
  getEvidenceFrontierStatus,
  inferEvidenceTopic,
} from "./frontier.js";
import { ArxivProvider } from "./providers.js";
import { normalizeArxivId } from "./search.js";
import { buildSemanticIndex } from "./semantic-index.js";
import type {
  KnowledgeRefreshResult,
  LlmProvider,
  LlmUsage,
  OpenAlexEnrichmentOptions,
  SearchProvider,
  SourceArtifact,
} from "./types.js";
import { readTextIfExists, sha256, walkFiles, writeText } from "./utils.js";

interface SourceSnapshot {
  id: string;
  title: string;
  metadataHash: string;
  versionId?: string;
  arxivId?: string;
  retracted: boolean;
  fullText: boolean;
}

interface LifecycleEvent {
  sourceId: string;
  detectedAt: string;
  type: "metadata-updated" | "version-changed" | "retracted" | "superseded";
  previousVersionId?: string;
  currentVersionId?: string;
  affectedClaimIds: string[];
}

export interface KnowledgeRefreshOptions extends OpenAlexEnrichmentOptions {
  force?: boolean;
  recompute?: boolean;
  arxivProvider?: SearchProvider;
}

function versionNumber(value: string | undefined): number {
  const match = value?.match(/v(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

async function refreshArxivVersions(
  options: KnowledgeRefreshOptions,
  sourcesDir: string,
): Promise<Map<string, string>> {
  const provider =
    options.arxivProvider ??
    new ArxivProvider(options.fetch ? { fetch: options.fetch } : {});
  const changed = new Map<string, string>();
  const sources = await Promise.all(
    (await walkFiles(sourcesDir, ".json")).map(
      async (file) =>
        JSON.parse(await readFile(file, "utf8")) as SourceArtifact,
    ),
  );
  const byArxivId = new Map<string, SourceArtifact[]>();
  for (const source of sources) {
    const arxivId = normalizeArxivId(source.literature?.arxivId);
    if (!arxivId) continue;
    byArxivId.set(arxivId, [...(byArxivId.get(arxivId) ?? []), source]);
  }
  for (const [arxivId, matchingSources] of byArxivId) {
    const results = await provider.search(arxivId, {
      limit: 5,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const exact = results
      .filter((result) => normalizeArxivId(result.arxivId) === arxivId)
      .sort(
        (left, right) =>
          versionNumber(right.versionId) - versionNumber(left.versionId),
      )[0];
    const latestStored = [...matchingSources].sort(
      (left, right) =>
        versionNumber(right.literature?.versionId) -
        versionNumber(left.literature?.versionId),
    )[0]!;
    if (
      !exact?.versionId ||
      versionNumber(exact.versionId) <=
        versionNumber(latestStored.literature?.versionId)
    ) {
      continue;
    }
    changed.set(latestStored.id, exact.versionId);
  }
  return changed;
}

async function snapshots(
  sourcesDir: string,
): Promise<Map<string, SourceSnapshot>> {
  const output = new Map<string, SourceSnapshot>();
  for (const file of await walkFiles(sourcesDir, ".json")) {
    const source = JSON.parse(await readFile(file, "utf8")) as SourceArtifact;
    output.set(source.id, {
      id: source.id,
      title: source.title,
      metadataHash: sha256(JSON.stringify(source.literature ?? {})),
      ...(source.literature?.versionId
        ? { versionId: source.literature.versionId }
        : {}),
      ...(source.literature?.arxivId
        ? { arxivId: source.literature.arxivId }
        : {}),
      retracted: source.literature?.isRetracted === true,
      fullText: !source.mediaType.includes("llmwiki.search-result"),
    });
  }
  return output;
}

function usageTotal(usage?: LlmUsage): Required<LlmUsage> {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  };
}

export async function refreshKnowledge(
  options: KnowledgeRefreshOptions = {},
): Promise<KnowledgeRefreshResult> {
  const config = await loadConfig(options.root);
  const now = options.now?.() ?? new Date();
  const statePath = path.join(config.metaDir, "lifecycle_state.json");
  const existingState = await readTextIfExists(statePath);
  const state = existingState
    ? (JSON.parse(existingState) as { lastRefreshAt?: unknown })
    : {};
  if (
    !options.force &&
    typeof state.lastRefreshAt === "string" &&
    now.getTime() - Date.parse(state.lastRefreshAt) <
      config.lifecycle.refreshIntervalHours * 3_600_000
  ) {
    return {
      path: statePath,
      skipped: true,
      reason: "refresh interval has not elapsed",
      scanned: 0,
      enriched: 0,
      retracted: 0,
      changedSourceIds: [],
      versionChangedSourceIds: [],
      metadataChanged: false,
      compiled: false,
      indexed: false,
      evaluated: false,
      frontier: await getEvidenceFrontierStatus(options),
      usage: {},
    };
  }
  const before = await snapshots(config.sourcesDir);
  const enrichment = await enrichOpenAlex({
    ...options,
    root: config.root,
    dryRun: false,
    onlyMissing: false,
  });
  const availableArxivVersions = await refreshArxivVersions(
    options,
    config.sourcesDir,
  );
  const after = await snapshots(config.sourcesDir);
  const changedSourceIds = [...after]
    .filter(
      ([id, source]) => before.get(id)?.metadataHash !== source.metadataHash,
    )
    .map(([id]) => id)
    .sort();
  const versionChangedSourceIds = [...availableArxivVersions.keys()].sort();
  const retractedSourceIds = [...after]
    .filter(([, source]) => source.retracted)
    .map(([id]) => id)
    .sort();
  const sourcesByArxiv = new Map<string, SourceSnapshot[]>();
  for (const source of after.values()) {
    const arxivId = normalizeArxivId(source.arxivId);
    if (!arxivId) continue;
    sourcesByArxiv.set(arxivId, [
      ...(sourcesByArxiv.get(arxivId) ?? []),
      source,
    ]);
  }
  const supersedes = [...sourcesByArxiv.values()].flatMap((sources) => {
    const preferred = [...sources].sort(
      (left, right) =>
        versionNumber(right.versionId) - versionNumber(left.versionId) ||
        Number(right.fullText) - Number(left.fullText) ||
        left.id.localeCompare(right.id),
    )[0];
    if (!preferred?.fullText) return [];
    return sources
      .filter(
        (source) =>
          source.id !== preferred.id &&
          (!source.fullText ||
            versionNumber(preferred.versionId) >
              versionNumber(source.versionId)),
      )
      .map((source) => ({
        fromSourceId: preferred.id,
        toSourceId: source.id,
        reason:
          versionNumber(preferred.versionId) > versionNumber(source.versionId)
            ? "newer arXiv full-text version"
            : "full text supersedes metadata-only evidence",
      }));
  });
  const supersededSourceIds = new Set(
    supersedes.map((edge) => edge.toSourceId),
  );
  const registryContent = await readTextIfExists(
    path.join(config.metaDir, "claims.json"),
  );
  const registry = registryContent
    ? (JSON.parse(registryContent) as {
        claims?: Array<{ id?: unknown; sourceId?: unknown }>;
      })
    : {};
  const claimsBySource = new Map<string, string[]>();
  for (const claim of registry.claims ?? []) {
    if (typeof claim.id !== "string" || typeof claim.sourceId !== "string") {
      throw new Error("Claim Registry contains an invalid lifecycle Claim");
    }
    claimsBySource.set(claim.sourceId, [
      ...(claimsBySource.get(claim.sourceId) ?? []),
      claim.id,
    ]);
  }
  const lifecycleChangedSourceIds = [
    ...new Set([...changedSourceIds, ...versionChangedSourceIds]),
  ].sort();
  const lifecyclePath = path.join(config.metaDir, "knowledge_lifecycle.json");
  const existingLifecycle = await readTextIfExists(lifecyclePath);
  const priorEvents = existingLifecycle
    ? ((JSON.parse(existingLifecycle) as { events?: LifecycleEvent[] })
        .events ?? [])
    : [];
  const events: LifecycleEvent[] = lifecycleChangedSourceIds.map((sourceId) => {
    const previous = before.get(sourceId);
    const current = after.get(sourceId)!;
    const availableVersion = availableArxivVersions.get(sourceId);
    const type = current.retracted
      ? "retracted"
      : availableVersion
        ? "version-changed"
        : "metadata-updated";
    return {
      sourceId,
      detectedAt: now.toISOString(),
      type,
      ...(previous?.versionId ? { previousVersionId: previous.versionId } : {}),
      ...((availableVersion ?? current.versionId)
        ? { currentVersionId: availableVersion ?? current.versionId }
        : {}),
      affectedClaimIds: claimsBySource.get(sourceId) ?? [],
    };
  });
  for (const edge of supersedes) {
    if (
      priorEvents.some(
        (event) =>
          event.type === "superseded" && event.sourceId === edge.toSourceId,
      )
    ) {
      continue;
    }
    events.push({
      sourceId: edge.toSourceId,
      detectedAt: now.toISOString(),
      type: "superseded",
      affectedClaimIds: claimsBySource.get(edge.toSourceId) ?? [],
    });
  }
  await writeText(
    lifecyclePath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: now.toISOString(),
        events: [...priorEvents, ...events].slice(-1_000),
        supersedes,
        sources: [...after.values()].map((source) => ({
          sourceId: source.id,
          versionId: source.versionId,
          ...(availableArxivVersions.get(source.id)
            ? {
                availableVersionId: availableArxivVersions.get(source.id),
              }
            : {}),
          retracted: source.retracted,
          fullText: source.fullText,
          metadataHash: source.metadataHash,
        })),
        claims: [...claimsBySource].flatMap(([sourceId, claimIds]) => {
          const source = after.get(sourceId);
          const versionReview = versionChangedSourceIds.includes(sourceId);
          return claimIds.map((claimId) => ({
            claimId,
            sourceId,
            status: source?.retracted
              ? "retracted-source"
              : versionReview
                ? "version-review-required"
                : supersededSourceIds.has(sourceId)
                  ? "superseded-source"
                  : "active",
          }));
        }),
      },
      null,
      2,
    ),
  );
  if (versionChangedSourceIds.length) {
    await admitEvidenceClues(
      versionChangedSourceIds.map((sourceId) => ({
        query:
          availableArxivVersions.get(sourceId) ??
          after.get(sourceId)!.arxivId ??
          after.get(sourceId)!.title,
        targetId: `source-${sourceId}`,
        problemId: `source-${sourceId}`,
        topicId: inferEvidenceTopic(after.get(sourceId)!.title, "refresh"),
        kind: "refresh",
        priority: 100,
      })),
      options,
    );
  }
  let compiled = false;
  let indexed = false;
  let evaluated = false;
  let usage: Required<LlmUsage> = { inputTokens: 0, outputTokens: 0 };
  if (changedSourceIds.length && options.recompute !== false) {
    const cacheOnlyProvider: LlmProvider = {
      name: "cache-only-refresh",
      async complete(request) {
        throw new Error(
          `Knowledge refresh encountered an uncached ${request.purpose} request; run an explicitly approved compile`,
        );
      },
    };
    const compilation = await compileWiki({
      root: config.root,
      llmProvider: cacheOnlyProvider,
      ...(options.now ? { now: options.now } : {}),
    });
    usage = usageTotal(compilation.usage);
    compiled = true;
    await buildSemanticIndex({
      root: config.root,
      ...(options.embeddingProvider
        ? { embeddingProvider: options.embeddingProvider }
        : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    indexed = true;
    if (
      await readTextIfExists(
        path.join(config.metaDir, "retrieval_benchmark.json"),
      )
    ) {
      await evaluateRetrieval({
        root: config.root,
        answer: false,
        ...(options.embeddingProvider
          ? { embeddingProvider: options.embeddingProvider }
          : {}),
        ...(options.now ? { now: options.now } : {}),
      });
      evaluated = true;
    }
  }
  await writeText(
    statePath,
    JSON.stringify(
      {
        version: 1,
        lastRefreshAt: now.toISOString(),
        lastChangedSourceIds: changedSourceIds,
        lastVersionChangedSourceIds: versionChangedSourceIds,
        lastRetractedSourceIds: retractedSourceIds,
      },
      null,
      2,
    ),
  );
  return {
    path: statePath,
    skipped: false,
    scanned: enrichment.scanned,
    enriched: enrichment.enriched,
    retracted: retractedSourceIds.length,
    changedSourceIds,
    versionChangedSourceIds,
    metadataChanged: changedSourceIds.length > 0,
    compiled,
    indexed,
    evaluated,
    frontier: await getEvidenceFrontierStatus(options),
    usage,
  };
}
