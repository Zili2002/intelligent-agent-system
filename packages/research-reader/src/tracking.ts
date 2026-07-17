import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  appendJsonLine,
  atomicWriteJson,
  readJsonIfExists,
  readJsonLines,
  withFileLock,
} from "@intelligent-agent/shared";
import {
  LlmUsageTracker,
  loadConfig,
  mapConcurrent,
  mergeSearchResults,
  requireLlm,
  searchWiki,
  type LlmProvider,
  type SearchResult,
} from "@intelligent-agent-system/llm-wiki-compiler";
import {
  canonicalLiteratureKey,
  mergeLiteratureMetadata,
  paperIdFromCanonicalKey,
  searchResultToMetadata,
} from "./identity.js";
import { generateDailyTrackingReport } from "./reports.js";
import {
  loadResearchProfile,
  loadSubscriptions,
  mutatePaperPassport,
} from "./store.js";
import { deterministicTriage, refineTriageWithLlm } from "./triage.js";
import type {
  PaperDiscovery,
  PaperPassport,
  ReaderSubscription,
  ReaderTrackOptions,
  ReaderTrackResult,
  ReaderTrackingRun,
  ResolvedReaderConfig,
  TriageResult,
} from "./types.js";

interface CandidateContext {
  key: string;
  result: SearchResult;
  subscriptions: ReaderSubscription[];
  discoveries: PaperDiscovery[];
  triage?: TriageResult;
}

export async function listTrackingRuns(
  config: ResolvedReaderConfig,
  limit = 20,
): Promise<ReaderTrackingRun[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Tracking run limit must be a positive integer");
  }
  let names: string[];
  try {
    names = await readdir(config.runsDir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const runs: ReaderTrackingRun[] = [];
  for (const name of names
    .filter(
      (entry) => entry.startsWith("reader-run-") && entry.endsWith(".json"),
    )
    .sort()) {
    const run = await readJsonIfExists(
      path.join(config.runsDir, name),
      parseTrackingRun,
    );
    if (run) runs.push(run);
  }
  return runs
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, limit);
}

export function readTrackingHistory(
  config: ResolvedReaderConfig,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  return readJsonLines(
    path.join(config.runsDir, "history.jsonl"),
    parseHistoryEvent,
    { limit },
  );
}

export async function trackLiterature(
  config: ResolvedReaderConfig,
  options: ReaderTrackOptions = {},
): Promise<ReaderTrackResult> {
  if (options.approveNetwork !== true) {
    throw new Error(
      "Literature tracking requires explicit network approval (approveNetwork: true)",
    );
  }
  const lockPath = path.join(config.runsDir, "locks", "tracking.lock");
  return withFileLock(lockPath, () => runTracking(config, options), {
    staleMs: config.scheduler.staleLockSeconds * 1_000,
  });
}

async function runTracking(
  config: ResolvedReaderConfig,
  options: ReaderTrackOptions,
): Promise<ReaderTrackResult> {
  const wallStartedAt = Date.now();
  const now = options.now ?? new Date();
  const run: ReaderTrackingRun = {
    version: 1,
    id: `reader-run-${randomUUID()}`,
    type: "tracking",
    status: "running",
    startedAt: now.toISOString(),
    subscriptions: 0,
    searches: 0,
    candidates: 0,
    created: 0,
    updated: 0,
    errors: [],
  };
  await persistRun(config, run);
  await appendRunEvent(config, run, "tracking_started");

  try {
    const subscriptionsState = await loadSubscriptions(config);
    const profile = await loadResearchProfile(config);
    if (!subscriptionsState || !profile) {
      throw new Error("Reader subscriptions or Research Profile are missing");
    }
    const subscriptions = subscriptionsState.items.filter(
      (subscription) => subscription.enabled,
    );
    run.subscriptions = subscriptions.length;
    const from = new Date(
      now.getTime() - config.tracking.lookbackDays * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const to = now.toISOString().slice(0, 10);
    const perSubscriptionLimit = Math.max(
      1,
      Math.min(
        100,
        options.limit ??
          Math.ceil(
            config.tracking.maxCandidatesPerRun /
              Math.max(1, subscriptions.length),
          ),
      ),
    );
    const searches = await mapConcurrent(
      subscriptions,
      config.tracking.concurrency,
      async (subscription) => {
        const providers =
          options.providers ??
          (subscription.providers?.length ? subscription.providers : undefined);
        const result = await searchWiki(subscription.query, {
          root: config.root,
          limit: perSubscriptionLimit,
          importResults: false,
          from,
          to,
          ...(providers ? { providers } : {}),
        });
        return { subscription, result };
      },
    );
    run.searches = searches.length;
    run.errors.push(
      ...searches.flatMap(({ subscription, result }) =>
        result.errors.map((error) => `${subscription.id}: ${error}`),
      ),
    );

    const contexts = mergeCandidateContexts(
      searches,
      run,
      config.tracking.maxCandidatesPerRun,
    );
    run.candidates = contexts.length;
    for (const context of contexts) {
      const subscription = preferredSubscription(context.subscriptions);
      context.triage = deterministicTriage(
        context.result,
        subscription,
        profile,
        config,
      );
    }

    const llm = await resolveTriageLlm(config, options);
    const usage = new LlmUsageTracker(options.maxLlmTokens);
    if (llm) {
      const selected = new Set(
        [...contexts]
          .filter((context) =>
            Boolean(context.result.abstract || context.result.snippet),
          )
          .sort(
            (left, right) =>
              (right.triage?.relevanceScore ?? 0) -
              (left.triage?.relevanceScore ?? 0),
          )
          .slice(0, config.tracking.maxLlmCandidatesPerRun)
          .map((context) => context.key),
      );
      await mapConcurrent(
        contexts.filter((context) => selected.has(context.key)),
        config.tracking.concurrency,
        async (context) => {
          try {
            context.triage = await refineTriageWithLlm(
              context.result,
              preferredSubscription(context.subscriptions),
              profile,
              context.triage!,
              llm,
              usage,
              config.triage.minimumRelevance,
            );
          } catch (error) {
            run.errors.push(
              `${context.key}: LLM triage degraded to deterministic: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        },
      );
    }

    const papers: PaperPassport[] = [];
    for (const context of contexts) {
      const paperId = paperIdFromCanonicalKey(context.key);
      let created = false;
      const paper = await mutatePaperPassport(config, paperId, (current) => {
        created = current === undefined;
        return updatePassport(current, context, profile.profileVersion, now);
      });
      papers.push(paper);
      if (!created) run.updated += 1;
      else run.created += 1;
    }

    run.status = "completed";
    run.completedAt = new Date().toISOString();
    run.durationMs = Math.max(0, Date.now() - wallStartedAt);
    const tokenUsage = usage.result();
    if (tokenUsage.inputTokens || tokenUsage.outputTokens) {
      run.usage = tokenUsage;
    }
    const report = await generateDailyTrackingReport(config, run, papers, to);
    run.reportPath = report.markdownPath;
    run.reportJsonPath = report.jsonPath;
    await persistRun(config, run);
    await appendRunEvent(config, run, "tracking_completed");
    return {
      run,
      papers,
      candidates: contexts.map((context) => context.result),
    };
  } catch (error) {
    run.status = "failed";
    run.completedAt = new Date().toISOString();
    run.durationMs = Math.max(0, Date.now() - wallStartedAt);
    run.errors.push(error instanceof Error ? error.message : String(error));
    await persistRun(config, run);
    await appendRunEvent(config, run, "tracking_failed");
    throw error;
  }
}

export async function recoverInterruptedTrackingRuns(
  config: ResolvedReaderConfig,
  now = new Date(),
): Promise<ReaderTrackingRun[]> {
  const interrupted = (await listTrackingRuns(config, 10_000)).filter(
    (run) => run.status === "running",
  );
  for (const run of interrupted) {
    run.status = "interrupted";
    run.completedAt = now.toISOString();
    run.durationMs = Math.max(0, now.getTime() - Date.parse(run.startedAt));
    run.errors.push("Run was interrupted before completion and recovered");
    await persistRun(config, run);
    await appendRunEvent(config, run, "tracking_interrupted");
  }
  return interrupted;
}

function mergeCandidateContexts(
  searches: Array<{
    subscription: ReaderSubscription;
    result: Awaited<ReturnType<typeof searchWiki>>;
  }>,
  run: ReaderTrackingRun,
  limit: number,
): CandidateContext[] {
  const byKey = new Map<string, CandidateContext>();
  for (const { subscription, result: search } of searches) {
    for (const result of search.results) {
      let key: string;
      try {
        key = canonicalLiteratureKey(result);
      } catch (error) {
        run.errors.push(
          `${subscription.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      const discovery: PaperDiscovery = {
        subscriptionId: subscription.id,
        query: subscription.query,
        provider: result.provider,
        runId: run.id,
        discoveredAt: run.startedAt,
      };
      const prior = byKey.get(key);
      if (!prior) {
        byKey.set(key, {
          key,
          result,
          subscriptions: [subscription],
          discoveries: [discovery],
        });
        continue;
      }
      prior.result = mergeSearchResults([prior.result, result])[0]!;
      if (!prior.subscriptions.some((item) => item.id === subscription.id)) {
        prior.subscriptions.push(subscription);
      }
      prior.discoveries.push(discovery);
    }
  }
  return [...byKey.values()]
    .sort(
      (left, right) =>
        (right.result.published ?? "").localeCompare(
          left.result.published ?? "",
        ) || left.result.title.localeCompare(right.result.title),
    )
    .slice(0, limit);
}

async function resolveTriageLlm(
  config: ResolvedReaderConfig,
  options: ReaderTrackOptions,
): Promise<LlmProvider | undefined> {
  if (options.llmProvider) return options.llmProvider;
  if (options.approveLlm !== true) return undefined;
  const wikiConfig = await loadConfig(config.root);
  return requireLlm(wikiConfig, {
    root: config.root,
    approveLlm: true,
    ...(options.maxLlmTokens === undefined
      ? {}
      : { maxLlmTokens: options.maxLlmTokens }),
  });
}

function updatePassport(
  existing: PaperPassport | undefined,
  context: CandidateContext,
  profileVersion: string,
  now: Date,
): PaperPassport {
  const timestamp = now.toISOString();
  const metadata = searchResultToMetadata(context.result);
  const triage = context.triage!;
  const versionChanged =
    existing?.lifecycle.latestVersionId !== undefined &&
    metadata.versionId !== undefined &&
    existing.lifecycle.latestVersionId !== metadata.versionId;
  if (!existing) {
    return {
      version: 1,
      id: paperIdFromCanonicalKey(context.key),
      canonicalKey: context.key,
      sourceIds: metadata.sourceId ? [metadata.sourceId] : [],
      metadata,
      candidate: structuredClone(context.result),
      discovery: context.discoveries,
      acquisition: { status: "metadata-only" },
      triage: {
        relevanceScore: triage.relevanceScore,
        confidence: triage.confidence,
        ...(triage.difficultyEstimate === undefined
          ? {}
          : { difficultyEstimate: triage.difficultyEstimate }),
        recommendation: triage.recommendation,
        reasons: triage.reasons,
        profileVersion,
        policyVersion: "triage-v1",
      },
      reading: {
        status: "unread",
        priority: priorityFor(triage.recommendation),
        userTags: [],
      },
      reviewIds: [],
      knowledge: {
        compiled: false,
        claimIds: [],
        wikiPaths: [],
      },
      lifecycle: {
        ...(metadata.versionId ? { latestVersionId: metadata.versionId } : {}),
        reviewStale: false,
        retracted: metadata.isRetracted === true,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  const paper = structuredClone(existing);
  paper.metadata = mergeLiteratureMetadata(existing.metadata, metadata);
  paper.candidate = structuredClone(context.result);
  paper.discovery.push(
    ...context.discoveries.filter(
      (discovery) =>
        !paper.discovery.some(
          (item) =>
            item.runId === discovery.runId &&
            item.subscriptionId === discovery.subscriptionId,
        ),
    ),
  );
  if (metadata.sourceId && !paper.sourceIds.includes(metadata.sourceId)) {
    paper.sourceIds.push(metadata.sourceId);
  }
  paper.triage = {
    relevanceScore: triage.relevanceScore,
    confidence: triage.confidence,
    ...(triage.difficultyEstimate === undefined
      ? {}
      : { difficultyEstimate: triage.difficultyEstimate }),
    recommendation: triage.recommendation,
    reasons: triage.reasons,
    profileVersion,
    policyVersion: "triage-v1",
  };
  if (
    (paper.reading.status === "unread" || paper.reading.status === "queued") &&
    paper.reading.userRating === undefined
  ) {
    paper.reading.priority = priorityFor(triage.recommendation);
  }
  if (metadata.versionId) paper.lifecycle.latestVersionId = metadata.versionId;
  if (versionChanged && paper.reviewIds.length) {
    paper.lifecycle.reviewStale = true;
  }
  paper.lifecycle.retracted =
    paper.lifecycle.retracted || metadata.isRetracted === true;
  paper.updatedAt = timestamp;
  return paper;
}

function preferredSubscription(
  subscriptions: ReaderSubscription[],
): ReaderSubscription {
  const subscription = [...subscriptions].sort(
    (left, right) =>
      right.weight - left.weight || left.id.localeCompare(right.id),
  )[0];
  if (!subscription) throw new Error("Candidate has no subscription context");
  return subscription;
}

function priorityFor(recommendation: TriageResult["recommendation"]): number {
  switch (recommendation) {
    case "priority":
      return 100;
    case "deep-read":
      return 75;
    case "manual-review":
      return 60;
    case "skim":
      return 50;
    case "archive":
      return 10;
  }
}

async function persistRun(
  config: ResolvedReaderConfig,
  run: ReaderTrackingRun,
): Promise<void> {
  await atomicWriteJson(path.join(config.runsDir, `${run.id}.json`), run);
}

async function appendRunEvent(
  config: ResolvedReaderConfig,
  run: ReaderTrackingRun,
  type: string,
): Promise<void> {
  await appendJsonLine(path.join(config.runsDir, "history.jsonl"), {
    timestamp: new Date().toISOString(),
    runId: run.id,
    type,
    status: run.status,
    candidates: run.candidates,
    created: run.created,
    updated: run.updated,
    errors: run.errors,
  });
}

function parseTrackingRun(value: unknown): ReaderTrackingRun {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("type" in value) ||
    value.type !== "tracking" ||
    !("status" in value) ||
    (value.status !== "running" &&
      value.status !== "completed" &&
      value.status !== "failed" &&
      value.status !== "interrupted") ||
    !("startedAt" in value) ||
    typeof value.startedAt !== "string"
  ) {
    throw new Error("Invalid Reader tracking run");
  }
  return value as ReaderTrackingRun;
}

function parseHistoryEvent(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Reader tracking history event");
  }
  return value as Record<string, unknown>;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
