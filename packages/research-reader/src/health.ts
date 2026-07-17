import { listApprovalRequests } from "./approvals.js";
import { getReaderStatus } from "./status.js";
import { listTrackingRuns } from "./tracking.js";
import type { ReaderHealth, ResolvedReaderConfig } from "./types.js";

export async function checkReaderHealth(
  config: ResolvedReaderConfig,
): Promise<ReaderHealth> {
  const [status, approvals, runs] = await Promise.all([
    getReaderStatus(config),
    listApprovalRequests(config, "pending"),
    listTrackingRuns(config, 10_000),
  ]);
  const completed = runs.filter((run) => run.status === "completed");
  const durations = completed
    .map((run) => run.durationMs)
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right);
  const metrics = {
    runs: runs.length,
    completedRuns: completed.length,
    averageDurationMs: durations.length
      ? durations.reduce((total, value) => total + value, 0) / durations.length
      : 0,
    p95DurationMs: percentile(durations, 0.95),
    candidates: runs.reduce((total, run) => total + run.candidates, 0),
    created: runs.reduce((total, run) => total + run.created, 0),
    updated: runs.reduce((total, run) => total + run.updated, 0),
    inputTokens: runs.reduce(
      (total, run) => total + (run.usage?.inputTokens ?? 0),
      0,
    ),
    outputTokens: runs.reduce(
      (total, run) => total + (run.usage?.outputTokens ?? 0),
      0,
    ),
  };
  const interruptedRuns = runs.filter(
    (run) => run.status === "interrupted",
  ).length;
  const recentFailures = runs
    .slice(0, 20)
    .filter((run) => run.status === "failed").length;
  return {
    ok: interruptedRuns === 0 && recentFailures === 0,
    root: config.root,
    schemaVersion: status.schemaVersion,
    trackingEnabled: config.tracking.enabled,
    schedulerEnabled: config.scheduler.enabled,
    anthropicConfigured: Boolean(
      process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
    ),
    openAlexConfigured: Boolean(process.env.OPENALEX_API_KEY),
    pendingApprovals: approvals.length,
    interruptedRuns,
    recentFailures,
    metrics,
  };
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * ratio) - 1),
  );
  return values[index]!;
}
