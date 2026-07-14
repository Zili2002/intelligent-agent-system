import { runExplorationCycle, resumeExperiment } from "../exploration/cycle.js";
import {
  loadMissionForExecution,
  saveMissionState,
} from "../mission/manager.js";
import type { AgentConfig } from "../types/config.js";
import type { ExplorationCycleResult } from "../exploration/cycle.js";
import type { Mission } from "../types/mission.js";
import { acquireMissionLock } from "./lock.js";
import { listApprovalRequests } from "./approvals.js";
import { findRecoverableExperiment } from "./recovery.js";
import { withRetry } from "./retry.js";
import {
  appendRunEvent,
  budgetSnapshot,
  createRunRecord,
  finishRunRecord,
  saveRunRecord,
} from "./store.js";
import type { RetryPolicy, RunRecord } from "./types.js";

export interface ContinuousRunOptions {
  root: string;
  intervalMs: number;
  maxDurationMs: number;
  maxCycles: number;
  retry: RetryPolicy;
  signal?: AbortSignal;
  staleLockMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  executeStep?: (
    missionReference: string,
    config: AgentConfig,
    root: string,
  ) => Promise<MissionStep>;
  onCycle?: (mission: Mission, result: ExplorationCycleResult) => Promise<void>;
}

export interface MissionStep {
  mission: Mission;
  result?: ExplorationCycleResult;
  recoveredExperiment: boolean;
}

export async function runContinuousMission(
  missionReference: string,
  config: AgentConfig,
  options: ContinuousRunOptions,
): Promise<RunRecord> {
  validateOptions(options);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableDelay;
  const executeStep = options.executeStep ?? executeMissionStep;
  const initialMission = await loadMissionForExecution(
    missionReference,
    options.root,
    { allowCompleted: true },
  );
  const lock = await acquireMissionLock(options.root, initialMission.id, {
    staleMs: options.staleLockMs,
  });
  let mission = initialMission;
  let run: RunRecord | undefined;

  try {
    mission = await loadMissionForExecution(missionReference, options.root, {
      allowCompleted: true,
    });
    const activeRun = await createRunRecord(mission, options.root);
    run = activeRun;
    const deadline = now() + options.maxDurationMs;
    if (mission.status === "completed") {
      await finishRunRecord(activeRun, mission, "completed", options.root);
      return activeRun;
    }

    while (
      activeRun.cycles < options.maxCycles &&
      now() < deadline &&
      !options.signal?.aborted
    ) {
      await appendRunEvent(options.root, {
        timestamp: new Date().toISOString(),
        runId: activeRun.id,
        missionId: mission.id,
        type: "cycle_started",
        message: `Starting scheduled cycle ${activeRun.cycles + 1}`,
      });

      const retried = await withRetry(
        async () => executeStep(missionReference, config, options.root),
        options.retry,
        {
          sleep: (milliseconds) => sleep(milliseconds, options.signal),
          onRetry: async ({ attempt, delayMs, error }) => {
            await appendRunEvent(options.root, {
              timestamp: new Date().toISOString(),
              runId: activeRun.id,
              missionId: mission.id,
              type: "retry_scheduled",
              message: `Transient failure on attempt ${attempt}; retrying after ${delayMs}ms: ${error.message}`,
              details: { attempt, delayMs },
            });
          },
        },
      );
      activeRun.attempts += retried.attempts;
      mission = retried.value.mission;
      const result = retried.value.result;

      if (!result) {
        await finishRunRecord(activeRun, mission, "completed", options.root);
        return activeRun;
      }

      activeRun.cycles += 1;
      activeRun.lastDecision = result.decision;
      activeRun.lastExperimentId = result.experiment?.id;
      activeRun.budgetAfter = budgetSnapshot(mission);
      await saveRunRecord(activeRun, options.root);
      if (retried.value.recoveredExperiment) {
        await appendRunEvent(options.root, {
          timestamp: new Date().toISOString(),
          runId: activeRun.id,
          missionId: mission.id,
          type: "experiment_recovered",
          message: `Recovered experiment ${result.experiment?.id ?? "unknown"}`,
        });
      }
      if (options.onCycle) {
        await withRetry(
          () => options.onCycle!(mission, result),
          options.retry,
          {
            sleep: (milliseconds) => sleep(milliseconds, options.signal),
            onRetry: async ({ attempt, delayMs, error }) => {
              await appendRunEvent(options.root, {
                timestamp: new Date().toISOString(),
                runId: activeRun.id,
                missionId: mission.id,
                type: "retry_scheduled",
                message: `Post-cycle integration failed on attempt ${attempt}; retrying after ${delayMs}ms: ${error.message}`,
                details: { attempt, delayMs, phase: "post_cycle" },
              });
            },
          },
        );
      }
      await appendRunEvent(options.root, {
        timestamp: new Date().toISOString(),
        runId: activeRun.id,
        missionId: mission.id,
        type: "cycle_completed",
        message: `Cycle ${activeRun.cycles} completed with decision ${result.decision.action}`,
        details: {
          decision: result.decision.action,
          experimentId: result.experiment?.id,
        },
      });

      const pendingRequests = await listApprovalRequests(
        options.root,
        mission.id,
      );
      if (
        result.experiment?.status === "awaiting_approval" ||
        pendingRequests.length > 0
      ) {
        await appendRunEvent(options.root, {
          timestamp: new Date().toISOString(),
          runId: activeRun.id,
          missionId: mission.id,
          type: "approval_required",
          message: result.experiment
            ? `Experiment ${result.experiment.id} is waiting for approval`
            : `Mission ${mission.id} has a pending approval request`,
        });
        await finishRunRecord(
          activeRun,
          mission,
          "waiting_approval",
          options.root,
        );
        return activeRun;
      }
      if (result.decision.action === "complete") {
        await finishRunRecord(activeRun, mission, "completed", options.root);
        return activeRun;
      }
      if (result.decision.action === "pause") {
        await finishRunRecord(activeRun, mission, "paused", options.root);
        return activeRun;
      }

      if (activeRun.cycles < options.maxCycles && now() < deadline) {
        const remainingMs = Math.max(0, deadline - now());
        await sleep(Math.min(options.intervalMs, remainingMs), options.signal);
      }
    }

    await finishRunRecord(activeRun, mission, "stopped", options.root);
    return activeRun;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (run) {
      if (options.signal?.aborted || message === "Continuous run aborted") {
        await finishRunRecord(run, mission, "stopped", options.root);
        return run;
      }
      await finishRunRecord(run, mission, "failed", options.root, message);
    }
    throw error;
  } finally {
    await lock.release();
  }
}

async function executeMissionStep(
  missionReference: string,
  config: AgentConfig,
  root: string,
): Promise<MissionStep> {
  const mission = await loadMissionForExecution(missionReference, root, {
    allowCompleted: true,
  });
  if (mission.status === "completed") {
    return { mission, recoveredExperiment: false };
  }

  const recoverable = await findRecoverableExperiment(root, mission.id);
  if (recoverable?.status === "awaiting_approval") {
    return {
      mission,
      recoveredExperiment: true,
      result: {
        mission,
        situation: await import("../exploration/orient.js").then(
          ({ orientAnalysis }) => orientAnalysis(mission),
        ),
        hypotheses: [recoverable.hypothesis],
        experiment: recoverable,
        decision: {
          action: "pause",
          rationale: `Experiment ${recoverable.id} requires approval`,
        },
      },
    };
  }
  if (recoverable?.status === "approved" || recoverable?.status === "running") {
    return {
      mission,
      recoveredExperiment: true,
      result: await resumeExperiment(mission, recoverable.id, config, {
        root,
        approve: true,
      }),
    };
  }

  if (mission.status === "paused") {
    return {
      mission,
      recoveredExperiment: false,
      result: {
        mission,
        situation: await import("../exploration/orient.js").then(
          ({ orientAnalysis }) => orientAnalysis(mission),
        ),
        hypotheses: [],
        decision: {
          action: "pause",
          rationale: "Mission is paused and has no recoverable experiment",
        },
      },
    };
  }
  if (mission.status === "pending") {
    mission.status = "active";
    mission.startedAt ??= new Date().toISOString();
    await saveMissionState(mission, root);
  }
  return {
    mission,
    recoveredExperiment: false,
    result: await runExplorationCycle(mission, config, { root }),
  };
}

function validateOptions(options: ContinuousRunOptions): void {
  if (options.intervalMs < 0) throw new Error("intervalMs cannot be negative");
  if (options.maxDurationMs <= 0)
    throw new Error("maxDurationMs must be positive");
  if (!Number.isInteger(options.maxCycles) || options.maxCycles < 1) {
    throw new Error("maxCycles must be a positive integer");
  }
}

async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("Continuous run aborted");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Continuous run aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
