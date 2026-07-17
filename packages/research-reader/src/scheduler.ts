import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  appendJsonLine,
  atomicWriteJson,
  redactSecrets,
  withFileLock,
  withRetry,
} from "@intelligent-agent/shared";
import { consumeApprovedRequest, ensureApprovalRequest } from "./approvals.js";
import { recoverInterruptedTrackingRuns, trackLiterature } from "./tracking.js";
import { millisecondsUntilNextCron } from "./cron.js";
import type {
  ReaderDaemonOptions,
  ReaderDaemonRecord,
  ReaderTrackOptions,
  ResolvedReaderConfig,
} from "./types.js";

export async function runReaderDaemon(
  config: ResolvedReaderConfig,
  options: ReaderDaemonOptions,
): Promise<ReaderDaemonRecord> {
  validateOptions(options);
  return withFileLock(
    path.join(config.runsDir, "locks", "daemon.lock"),
    () => runLockedDaemon(config, options),
    { staleMs: config.scheduler.staleLockSeconds * 1_000 },
  );
}

async function runLockedDaemon(
  config: ResolvedReaderConfig,
  options: ReaderDaemonOptions,
): Promise<ReaderDaemonRecord> {
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? abortableDelay;
  const trackStep = options.trackStep ?? trackLiterature;
  const record: ReaderDaemonRecord = {
    version: 1,
    id: `reader-daemon-${randomUUID()}`,
    status: "running",
    startedAt: new Date(clock()).toISOString(),
    cycles: 0,
    attempts: 0,
    trackingRunIds: [],
  };
  await saveDaemon(config, record);
  await appendDaemonEvent(config, record, "daemon_started");
  await recoverInterruptedTrackingRuns(config, new Date(clock()));

  let networkApproved = options.approveNetwork === true;
  if (!networkApproved) {
    networkApproved = Boolean(
      await consumeApprovedRequest(config, "network", new Date(clock())),
    );
  }
  if (!networkApproved) {
    await ensureApprovalRequest(
      config,
      "network",
      "Approve scheduled literature provider requests",
      { daemonId: record.id },
      new Date(clock()),
    );
    record.status = "waiting-approval";
    record.completedAt = new Date(clock()).toISOString();
    await saveDaemon(config, record);
    await appendDaemonEvent(config, record, "daemon_waiting_approval");
    return record;
  }

  const deadline = clock() + options.maxDurationMs;
  try {
    while (
      record.cycles < options.maxCycles &&
      clock() < deadline &&
      !options.signal?.aborted
    ) {
      const result = await withRetry(
        () => trackStep(config, trackingOptions(options, new Date(clock()))),
        options.retry,
        {
          sleep: (milliseconds) => sleep(milliseconds, options.signal),
          onRetry: async ({ attempt, delayMs, error }) => {
            await appendJsonLine(path.join(config.runsDir, "history.jsonl"), {
              timestamp: new Date(clock()).toISOString(),
              daemonId: record.id,
              type: "daemon_retry",
              attempt,
              delayMs,
              error: redactSecrets(error.message),
            });
          },
        },
      );
      record.attempts += result.attempts;
      record.cycles += 1;
      record.trackingRunIds.push(result.value.run.id);
      await saveDaemon(config, record);
      await appendDaemonEvent(config, record, "daemon_cycle_completed");
      if (record.cycles < options.maxCycles && clock() < deadline) {
        const configuredDelay = config.scheduler.cron
          ? millisecondsUntilNextCron(
              config.scheduler.cron,
              config.scheduler.timezone,
              new Date(clock()),
            )
          : options.intervalMs;
        await sleep(
          Math.min(configuredDelay, Math.max(0, deadline - clock())),
          options.signal,
        );
      }
    }
    record.status =
      options.signal?.aborted || clock() >= deadline ? "stopped" : "completed";
    record.completedAt = new Date(clock()).toISOString();
    await saveDaemon(config, record);
    await appendDaemonEvent(config, record, "daemon_finished");
    return record;
  } catch (error) {
    record.status = "failed";
    record.completedAt = new Date(clock()).toISOString();
    record.error = redactSecrets(
      error instanceof Error ? error.message : String(error),
    );
    await saveDaemon(config, record);
    await appendDaemonEvent(config, record, "daemon_failed");
    throw error;
  }
}

function trackingOptions(
  options: ReaderDaemonOptions,
  now: Date,
): ReaderTrackOptions {
  return {
    approveNetwork: true,
    ...(options.approveLlm === true ? { approveLlm: true } : {}),
    ...(options.providers ? { providers: options.providers } : {}),
    ...(options.llmProvider ? { llmProvider: options.llmProvider } : {}),
    ...(options.maxLlmTokens === undefined
      ? {}
      : { maxLlmTokens: options.maxLlmTokens }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    now,
  };
}

async function saveDaemon(
  config: ResolvedReaderConfig,
  record: ReaderDaemonRecord,
): Promise<void> {
  await atomicWriteJson(path.join(config.runsDir, `${record.id}.json`), record);
}

async function appendDaemonEvent(
  config: ResolvedReaderConfig,
  record: ReaderDaemonRecord,
  type: string,
): Promise<void> {
  await appendJsonLine(path.join(config.runsDir, "history.jsonl"), {
    timestamp: new Date().toISOString(),
    daemonId: record.id,
    type,
    status: record.status,
    cycles: record.cycles,
    attempts: record.attempts,
  });
}

function validateOptions(options: ReaderDaemonOptions): void {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0) {
    throw new Error("Daemon intervalMs must be non-negative");
  }
  if (!Number.isFinite(options.maxDurationMs) || options.maxDurationMs <= 0) {
    throw new Error("Daemon maxDurationMs must be positive");
  }
  if (!Number.isInteger(options.maxCycles) || options.maxCycles < 1) {
    throw new Error("Daemon maxCycles must be a positive integer");
  }
}

async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("Reader daemon aborted");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Reader daemon aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
