import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { designExperiment } from "../src/exploration/design.js";
import { runExplorationCycle } from "../src/exploration/cycle.js";
import { saveExperiment } from "../src/experiment/store.js";
import { loadMission, saveMissionState } from "../src/mission/manager.js";
import {
  approveExperiment,
  approveRequest,
  consumeApprovalRequest,
  ensureApprovalRequest,
  listApprovalRequests,
  listPendingApprovals,
  rejectExperiment,
  rejectRequest,
} from "../src/runtime/approvals.js";
import { checkAgentHealth } from "../src/runtime/health.js";
import { acquireMissionLock } from "../src/runtime/lock.js";
import { findRecoverableExperiment } from "../src/runtime/recovery.js";
import { withRetry } from "../src/runtime/retry.js";
import {
  runContinuousMission,
  type MissionStep,
} from "../src/runtime/scheduler.js";
import {
  appendRunEvent,
  createRunRecord,
  finishRunRecord,
  listRunRecords,
  readRunHistory,
} from "../src/runtime/store.js";
import { defaultConfig } from "../src/types/config.js";
import type { Hypothesis } from "../src/types/experiment.js";
import type { Mission } from "../src/types/mission.js";
import { initConfig } from "../src/utils/config.js";

async function createMission(
  root: string,
  name = "Runtime Mission",
): Promise<Mission> {
  const missionPath = path.join(root, "mission.md");
  await writeFile(
    missionPath,
    `# Mission: ${name}

## Objective
Exercise stable continuous operation.

## Success Metrics
- Experiments completed: >= 1
`,
    "utf8",
  );
  const mission = await loadMission(missionPath, root);
  mission.status = "active";
  await saveMissionState(mission, root);
  return mission;
}

test("run records and history are persisted with secret redaction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-run-store-"));
  try {
    const mission = await createMission(root);
    const run = await createRunRecord(mission, root);
    await appendRunEvent(root, {
      timestamp: new Date().toISOString(),
      runId: run.id,
      missionId: mission.id,
      type: "cycle_started",
      message: "ANTHROPIC_AUTH_TOKEN=secret-value-that-must-not-appear",
    });
    await finishRunRecord(run, mission, "completed", root);

    const runs = await listRunRecords(root);
    const history = await readRunHistory(root);
    assert.equal(runs[0]?.status, "completed");
    assert.ok(history.some((event) => event.type === "run_started"));
    assert.ok(history.some((event) => event.type === "run_completed"));
    assert.equal(
      JSON.stringify(history).includes("secret-value-that-must-not-appear"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mission locks exclude concurrent processes and recover stale owners", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-lock-"));
  try {
    const first = await acquireMissionLock(root, "mission-lock-test");
    await assert.rejects(
      () => acquireMissionLock(root, "mission-lock-test"),
      /already running/,
    );
    await first.release();

    const lockDirectory = path.join(root, "runs", "locks");
    await mkdir(lockDirectory, { recursive: true });
    const stalePath = path.join(lockDirectory, "mission-stale.lock");
    await writeFile(
      stalePath,
      JSON.stringify({
        owner: "stale",
        pid: 999_999,
        hostname: os.hostname(),
        createdAt: new Date(0).toISOString(),
      }),
      "utf8",
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(stalePath, old, old);
    const recovered = await acquireMissionLock(root, "mission-stale", {
      staleMs: 1,
    });
    await recovered.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retry uses bounded exponential backoff only for transient errors", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const result = await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("ECONNRESET transient failure");
      return "ok";
    },
    { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 100 },
    { sleep: async (milliseconds) => void delays.push(milliseconds) },
  );
  assert.equal(result.value, "ok");
  assert.equal(result.attempts, 3);
  assert.deepEqual(delays, [10, 20]);

  let budgetAttempts = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          budgetAttempts += 1;
          throw new Error("Budget stop threshold reached");
        },
        { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2 },
      ),
    /Budget/,
  );
  assert.equal(budgetAttempts, 1);
});

test("approval queue approves, rejects, audits, and exposes recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-approval-"));
  try {
    const mission = await createMission(root, "Approval Runtime");
    const config = structuredClone(defaultConfig);
    config.analysis.mode = "rule-based";
    config.sandbox.type = "local";
    const designed = await runExplorationCycle(mission, config, { root });
    const pendingId = designed.experiment!.id;

    assert.equal((await listPendingApprovals(root)).length, 1);
    const approved = await approveExperiment(
      root,
      mission.id,
      pendingId,
      config,
      "reviewer",
    );
    assert.equal(approved.status, "approved");
    assert.equal(
      (await findRecoverableExperiment(root, mission.id))?.id,
      pendingId,
    );

    const hypothesis: Hypothesis = {
      id: "hyp-reject",
      statement: "Rejected experiment",
      rationale: "approval test",
      expectedOutcome: "cancelled",
      confidence: 1,
      relatedKnowledge: [],
    };
    const rejectedCandidate = designExperiment(mission, hypothesis);
    rejectedCandidate.status = "awaiting_approval";
    await saveExperiment(rejectedCandidate, root);
    const rejected = await rejectExperiment(
      root,
      mission.id,
      rejectedCandidate.id,
      "Not needed",
      "reviewer",
    );
    assert.equal(rejected.status, "cancelled");
    const history = await readRunHistory(root);
    assert.ok(history.some((event) => event.type === "approval_granted"));
    assert.ok(history.some((event) => event.type === "approval_rejected"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generic LLM approval requests can be approved, consumed, and rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-llm-approval-"));
  try {
    const mission = await createMission(root, "LLM Approval Runtime");
    const request = await ensureApprovalRequest(
      root,
      mission.id,
      "Approve a paid design request",
      { estimatedInputTokens: 100, requestedOutputTokens: 200 },
    );
    assert.equal(request.status, "pending");
    assert.equal((await listApprovalRequests(root, mission.id)).length, 1);
    await assert.rejects(
      () => approveRequest(root, request.id, "reviewer", "mission-different"),
      /belongs to/,
    );

    const approved = await approveRequest(root, request.id, "reviewer");
    assert.equal(approved.status, "approved");
    await consumeApprovalRequest(root, mission.id);
    const renewed = await ensureApprovalRequest(
      root,
      mission.id,
      "Approve another paid design request",
    );
    assert.equal(renewed.status, "pending");
    const rejected = await rejectRequest(
      root,
      renewed.id,
      "Budget no longer available",
      "reviewer",
    );
    assert.equal(rejected.status, "rejected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continuous scheduler performs a deterministic multi-cycle soak", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-soak-"));
  try {
    const mission = await createMission(root, "Scheduler Soak");
    const config = structuredClone(defaultConfig);
    let cycle = 0;
    let hookAttempts = 0;
    const executeStep = async (): Promise<MissionStep> => {
      cycle += 1;
      mission.status = cycle === 100 ? "completed" : "active";
      return {
        mission,
        recoveredExperiment: false,
        result: {
          mission,
          situation: {
            missionId: mission.id,
            timestamp: new Date().toISOString(),
            currentState: {
              progress: cycle / 100,
              metricsAchieved: cycle === 100 ? 1 : 0,
              experimentsCompleted: cycle,
              knowledgeGaps: [],
            },
            opportunities: [],
            risks: [],
            recommendations: [],
          },
          hypotheses: [],
          decision: {
            action: cycle === 100 ? "complete" : "continue",
            rationale: `soak cycle ${cycle}`,
          },
        },
      };
    };

    const run = await runContinuousMission(mission.id, config, {
      root,
      intervalMs: 1,
      maxDurationMs: 60_000,
      maxCycles: 120,
      retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 4 },
      executeStep,
      onCycle: async () => {
        hookAttempts += 1;
        if (hookAttempts < 3) {
          throw new Error("ECONNRESET post-cycle integration failure");
        }
      },
      sleep: async () => {},
      now: () => 0,
    });

    assert.equal(run.status, "completed");
    assert.equal(run.cycles, 100);
    assert.equal(run.attempts, 100);
    assert.equal(hookAttempts, 102);
    const lock = await acquireMissionLock(root, mission.id);
    await lock.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continuous scheduler never sleeps past max duration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-duration-"));
  try {
    const mission = await createMission(root, "Scheduler Duration");
    const config = structuredClone(defaultConfig);
    let clock = 0;
    const sleeps: number[] = [];
    const run = await runContinuousMission(mission.id, config, {
      root,
      intervalMs: 2_000,
      maxDurationMs: 2_500,
      maxCycles: 10,
      retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
      executeStep: async (): Promise<MissionStep> => ({
        mission,
        recoveredExperiment: false,
        result: {
          mission,
          situation: {
            missionId: mission.id,
            timestamp: new Date().toISOString(),
            currentState: {
              progress: 0,
              metricsAchieved: 0,
              experimentsCompleted: 0,
              knowledgeGaps: [],
            },
            opportunities: [],
            risks: [],
            recommendations: [],
          },
          hypotheses: [],
          decision: { action: "continue", rationale: "duration test" },
        },
      }),
    });
    assert.equal(run.status, "stopped");
    assert.deepEqual(sleeps, [2_000, 500]);
    assert.equal(clock, 2_500);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continuous scheduler stops at the approval queue", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-daemon-approval-"));
  try {
    const mission = await createMission(root, "Daemon Approval");
    const config = structuredClone(defaultConfig);
    config.analysis.mode = "rule-based";
    config.sandbox.type = "local";
    const run = await runContinuousMission(mission.id, config, {
      root,
      intervalMs: 0,
      maxDurationMs: 10_000,
      maxCycles: 3,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2 },
    });

    assert.equal(run.status, "waiting_approval");
    assert.equal((await listPendingApprovals(root, mission.id)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continuous scheduler records graceful aborts as stopped", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-daemon-abort-"));
  try {
    const mission = await createMission(root, "Daemon Abort");
    const controller = new AbortController();
    const config = structuredClone(defaultConfig);
    const run = await runContinuousMission(mission.id, config, {
      root,
      intervalMs: 1,
      maxDurationMs: 10_000,
      maxCycles: 3,
      retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
      signal: controller.signal,
      executeStep: async (): Promise<MissionStep> => ({
        mission,
        recoveredExperiment: false,
        result: {
          mission,
          situation: {
            missionId: mission.id,
            timestamp: new Date().toISOString(),
            currentState: {
              progress: 0,
              metricsAchieved: 0,
              experimentsCompleted: 0,
              knowledgeGaps: [],
            },
            opportunities: [],
            risks: [],
            recommendations: [],
          },
          hypotheses: [],
          decision: { action: "continue", rationale: "continue until abort" },
        },
      }),
      sleep: async () => {
        controller.abort();
        throw new Error("Continuous run aborted");
      },
    });
    assert.equal(run.status, "stopped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continuous scheduler persists paid LLM requests before API use", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-daemon-llm-"));
  const previousToken = process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    process.env.ANTHROPIC_AUTH_TOKEN = "must-not-be-called";
    const mission = await createMission(root, "Daemon LLM Approval");
    mission.budget.approvalRequired = true;
    mission.budget.llmTokens = 10_000;
    await saveMissionState(mission, root);
    const config = structuredClone(defaultConfig);
    config.analysis.mode = "llm";

    const run = await runContinuousMission(mission.id, config, {
      root,
      intervalMs: 0,
      maxDurationMs: 10_000,
      maxCycles: 2,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2 },
    });

    assert.equal(run.status, "waiting_approval");
    const requests = await listApprovalRequests(root, mission.id);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.type, "llm_design");
    assert.equal(mission.budget.llmTokensUsed, 0);
  } finally {
    if (previousToken === undefined) {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    } else {
      process.env.ANTHROPIC_AUTH_TOKEN = previousToken;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("health reports configuration and credential state without secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-health-"));
  try {
    await initConfig(root);
    const report = await checkAgentHealth(root);
    assert.ok(report.status === "healthy" || report.status === "degraded");
    assert.ok(report.checks.some((check) => check.name === "config"));
    assert.equal(
      JSON.stringify(report).includes("ANTHROPIC_AUTH_TOKEN="),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
