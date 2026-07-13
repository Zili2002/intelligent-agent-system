import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  initWiki,
  queryWiki,
} from "@intelligent-agent-system/llm-wiki-compiler";
import {
  resumeExperiment,
  runExplorationCycle,
} from "../src/exploration/cycle.js";
import {
  experimentDirectory,
  saveExperiment,
} from "../src/experiment/store.js";
import { syncExperimentToWiki } from "../src/knowledge/wiki.js";
import {
  backupMissionState,
  loadMission,
  loadMissionForExecution,
  resumeMissionState,
  saveMissionState,
  updateMetric,
} from "../src/mission/manager.js";
import { executeInLocal } from "../src/sandbox/local.js";
import { assessExperimentSafety } from "../src/sandbox/safety.js";
import { defaultConfig } from "../src/types/config.js";
import type { Experiment } from "../src/types/experiment.js";
import { initConfig, loadConfig } from "../src/utils/config.js";

test("mission Markdown parsing is stable and supports documented lists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-parser-"));
  try {
    const missionPath = path.join(root, "mission.md");
    await writeFile(
      missionPath,
      `# Mission: Reliable Research

**Status**: Draft
**Budget**: $12 USD
**Priority**: High
**Iterations**: 4

## Objective

Collect reproducible evidence.

## Success Criteria

1. **Experiments completed**: >= 2
2. **Evidence quality**: high

## Constraints

- **Safety**: No network access

## Budget

- LLM Tokens: 10K
- Compute: 2 CPU hours
- Approval Required: No
`,
      "utf8",
    );

    const first = await loadMission(missionPath, root);
    const second = await loadMission(missionPath, root);

    assert.equal(first.id, "mission-reliable-research");
    assert.equal(first.id, second.id);
    assert.equal(first.priority, "high");
    assert.equal(first.maxIterations, 4);
    assert.equal(first.successMetrics.length, 2);
    assert.equal(first.budget.llmTokens, 10_000);
    assert.equal(first.budget.computeHours, 2);
    assert.equal(first.budget.costLimit, 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted mission JSON reloads and numeric metrics are evaluated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-state-"));
  try {
    const missionPath = path.join(root, "mission.md");
    await writeFile(
      missionPath,
      `# Mission: Metric State

## Objective
Persist progress.

## Success Metrics
- Score: >= 90%
`,
      "utf8",
    );
    const mission = await loadMission(missionPath, root);
    updateMetric(mission, "Score", "92%");
    await saveMissionState(mission, root);

    const restored = await loadMission(mission.id, root);
    assert.equal(restored.successMetrics[0].achieved, true);
    assert.equal(restored.successMetrics[0].current, "92%");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline local cycle executes with Node and completes a measurable mission", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-cycle-"));
  try {
    const missionPath = path.join(root, "mission.md");
    await writeFile(
      missionPath,
      `# Mission: Execute Once

## Objective
Run one verified experiment.

## Success Metrics
- Experiments completed: >= 1

## Budget
- LLM Tokens: 10K
- Compute: 1 CPU hours
- Approval Required: No
`,
      "utf8",
    );
    const mission = await loadMission(missionPath, root);
    mission.status = "active";
    const config = structuredClone(defaultConfig);
    config.analysis.mode = "rule-based";
    config.sandbox.type = "local";

    const result = await runExplorationCycle(mission, config, {
      root,
      approve: true,
    });

    assert.equal(result.execution?.success, true);
    assert.equal(result.experiment?.status, "completed");
    assert.equal(result.decision.action, "complete");
    assert.equal(mission.status, "completed");
    assert.equal(mission.successMetrics[0].achieved, true);

    const resultsPath = path.join(
      root,
      "experiments",
      result.experiment!.id,
      "results.json",
    );
    const resultDocument = JSON.parse(await readFile(resultsPath, "utf8"));
    assert.equal(resultDocument.status, "completed");
    assert.equal(typeof resultDocument.measurements.duration_ms, "number");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe generated code is rejected before execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-safety-"));
  try {
    const missionPath = path.join(root, "mission.md");
    await writeFile(
      missionPath,
      `# Mission: Safety

## Objective
Reject unsafe code.
`,
      "utf8",
    );
    const mission = await loadMission(missionPath, root);
    const experiment: Experiment = {
      id: "exp-unsafe",
      missionId: mission.id,
      hypothesis: {
        id: "hyp-unsafe",
        statement: "Unsafe execution",
        rationale: "test",
        expectedOutcome: "test",
        confidence: 0,
        relatedKnowledge: [],
      },
      status: "designed",
      design: {
        description: "unsafe",
        steps: [],
        code: 'import { exec } from "node:child_process"; exec("whoami");',
        codeLanguage: "javascript",
        entrypoint: "experiment.mjs",
        expectedDuration: "1 second",
        resourceEstimate: {
          cpu: 1,
          memory: "64MB",
          disk: "1MB",
        },
      },
      createdAt: new Date().toISOString(),
    };

    const assessment = assessExperimentSafety(
      experiment,
      mission,
      structuredClone(defaultConfig),
    );
    assert.equal(assessment.safe, false);
    assert.match(assessment.violations.join("\n"), /Child-process/);

    const shellAssessment = assessExperimentSafety(
      {
        ...experiment,
        id: "exp-unsafe-shell",
        design: {
          ...experiment.design,
          code: "curl https://example.invalid",
          codeLanguage: "bash",
          entrypoint: "experiment.sh",
        },
      },
      mission,
      structuredClone(defaultConfig),
    );
    assert.equal(shellAssessment.safe, false);
    assert.match(shellAssessment.violations.join("\n"), /Network/);

    const localConfig = structuredClone(defaultConfig);
    localConfig.sandbox.type = "local";
    const localAssessment = assessExperimentSafety(
      {
        ...experiment,
        id: "exp-safe-local",
        design: {
          ...experiment.design,
          code: 'console.log("safe")',
          origin: "manual",
        },
      },
      mission,
      localConfig,
    );
    assert.equal(localAssessment.safe, true);
    assert.equal(localAssessment.requiresApproval, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local execution does not inherit API keys or unrelated environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-local-env-"));
  const previousKey = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = "must-not-leak";
    const script = path.join(root, "environment.mjs");
    await writeFile(
      script,
      `import { writeFile } from "node:fs/promises";
await writeFile("environment.json", JSON.stringify(process.env), "utf8");`,
      "utf8",
    );
    const result = await executeInLocal(
      script,
      {
        type: "local",
        local: {
          timeout: 10,
          allowedCommands: ["node"],
        },
      },
      {
        workDir: root,
        timeout: 10,
        command: process.execPath,
        args: [script],
        env: { EXPERIMENT_ID: "exp-env" },
      },
    );
    assert.equal(result.success, true);
    const environment = JSON.parse(
      await readFile(path.join(root, "environment.json"), "utf8"),
    );
    assert.equal(environment.ANTHROPIC_API_KEY, undefined);
    assert.equal(environment.EXPERIMENT_ID, "exp-env");
  } finally {
    if (previousKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousKey;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("paid experiment design is approval-gated before any token spend", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-llm-approval-"));
  const previousKey = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = "test-key-that-must-not-be-called";
    const missionPath = path.join(root, "mission.md");
    await writeFile(
      missionPath,
      `# Mission: Paid Approval

## Objective
Require approval before paid reasoning.

## Success Metrics
- Experiments completed: >= 1

## Budget
- LLM Tokens: 10K
- Approval Required: Yes
`,
      "utf8",
    );
    const mission = await loadMission(missionPath, root);
    mission.status = "active";
    const config = structuredClone(defaultConfig);

    const result = await runExplorationCycle(mission, config, { root });
    assert.equal(result.decision.action, "pause");
    assert.equal(result.experiment, undefined);
    assert.match(result.decision.rationale, /requires explicit approval/i);
    assert.equal(mission.budget.llmTokensUsed, 0);
    assert.equal(mission.budget.costSpent, 0);
  } finally {
    if (previousKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousKey;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("paid design is rejected when input and output cannot fit the token budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-llm-budget-"));
  const previousKey = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = "test-key-that-must-not-be-called";
    const missionPath = path.join(root, "mission.md");
    await writeFile(
      missionPath,
      `# Mission: Tiny Token Budget

## Objective
Reject a paid request that cannot fit the total token budget.

## Success Metrics
- Experiments completed: >= 1

## Budget
- LLM Tokens: 100
- Approval Required: No
`,
      "utf8",
    );
    const mission = await loadMission(missionPath, root);
    mission.status = "active";
    const config = structuredClone(defaultConfig);

    const result = await runExplorationCycle(mission, config, {
      root,
      approve: true,
    });
    assert.equal(result.decision.action, "pause");
    assert.equal(result.experiment, undefined);
    assert.match(result.decision.rationale, /token budget/i);
    assert.equal(mission.budget.llmTokensUsed, 0);
  } finally {
    if (previousKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousKey;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("approval-gated experiments can be resumed from persisted state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-resume-"));
  try {
    const missionPath = path.join(root, "mission.md");
    await writeFile(
      missionPath,
      `# Mission: Approval Resume

## Objective
Resume reviewed work.

## Success Metrics
- Experiments completed: >= 1

## Budget
- Approval Required: Yes
`,
      "utf8",
    );
    const mission = await loadMission(missionPath, root);
    mission.status = "active";
    const config = structuredClone(defaultConfig);
    config.analysis.mode = "rule-based";
    config.sandbox.type = "local";

    const designed = await runExplorationCycle(mission, config, { root });
    assert.equal(designed.experiment?.status, "awaiting_approval");
    assert.equal(mission.experimentIds.length, 0);

    const resumed = await resumeExperiment(
      mission,
      designed.experiment!.id,
      config,
      { root, approve: true },
    );
    assert.equal(resumed.experiment?.id, designed.experiment?.id);
    assert.equal(resumed.experiment?.status, "completed");
    assert.equal(resumed.decision.action, "complete");
    assert.equal(mission.experimentIds.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumed experiments cannot bypass an exhausted budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-resume-budget-"));
  try {
    const missionPath = path.join(root, "mission.md");
    await writeFile(
      missionPath,
      `# Mission: Resume Budget

**Budget**: $10 USD

## Objective
Do not execute after budget exhaustion.

## Success Metrics
- Experiments completed: >= 1
`,
      "utf8",
    );
    const mission = await loadMission(missionPath, root);
    mission.status = "active";
    const config = structuredClone(defaultConfig);
    config.analysis.mode = "rule-based";
    config.sandbox.type = "local";

    const designed = await runExplorationCycle(mission, config, { root });
    assert.equal(designed.experiment?.status, "awaiting_approval");
    mission.budget.costSpent = 9.5;

    const resumed = await resumeExperiment(
      mission,
      designed.experiment!.id,
      config,
      { root, approve: true },
    );
    assert.equal(resumed.decision.action, "pause");
    assert.equal(resumed.execution, undefined);
    assert.match(resumed.decision.rationale, /budget/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale results cannot update metrics after a rerun", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-stale-result-"));
  try {
    const missionPath = path.join(root, "mission.md");
    await writeFile(
      missionPath,
      `# Mission: Fresh Results

## Objective
Only accept results from the current run.

## Success Metrics
- Score: >= 1
`,
      "utf8",
    );
    const mission = await loadMission(missionPath, root);
    mission.status = "active";
    const experiment: Experiment = {
      id: "exp-stale-result",
      missionId: mission.id,
      hypothesis: {
        id: "hyp-stale-result",
        statement: "A fresh result is required",
        rationale: "test stale output handling",
        expectedOutcome: "No stale metrics are applied",
        confidence: 1,
        relatedKnowledge: [],
      },
      status: "awaiting_approval",
      design: {
        description: "Exit successfully without writing results",
        steps: ["Run without producing results.json"],
        code: 'console.log("no result produced")',
        codeLanguage: "javascript",
        entrypoint: "experiment.mjs",
        origin: "manual",
        expectedDuration: "1 second",
        resourceEstimate: {
          cpu: 1,
          memory: "64MB",
          disk: "1MB",
        },
      },
      createdAt: new Date().toISOString(),
    };
    const directory = await saveExperiment(experiment, root);
    await writeFile(
      path.join(directory, "results.json"),
      JSON.stringify({
        runId: "old-run",
        status: "completed",
        metricUpdates: { Score: 1 },
      }),
      "utf8",
    );
    const config = structuredClone(defaultConfig);
    config.analysis.mode = "rule-based";
    config.sandbox.type = "local";

    const result = await resumeExperiment(mission, experiment.id, config, {
      root,
      approve: true,
    });
    assert.equal(result.experiment?.status, "failed");
    assert.equal(mission.successMetrics[0].achieved, false);
    assert.deepEqual(mission.successfulExperimentIds, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("budget stop thresholds prevent new experiment design", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-budget-"));
  try {
    const missionPath = path.join(root, "mission.md");
    await writeFile(
      missionPath,
      `# Mission: Budget Stop

**Budget**: $10 USD

## Objective
Respect the hard budget.

## Success Metrics
- Experiments completed: >= 1
`,
      "utf8",
    );
    const mission = await loadMission(missionPath, root);
    mission.status = "active";
    mission.budget.costSpent = 9.5;
    const config = structuredClone(defaultConfig);
    config.analysis.mode = "rule-based";
    config.sandbox.type = "local";

    const result = await runExplorationCycle(mission, config, { root });
    assert.equal(result.decision.action, "pause");
    assert.equal(result.experiment, undefined);
    assert.match(result.decision.rationale, /budget/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loading defaults returns independent validated configuration objects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-config-"));
  try {
    const nestedRoot = path.join(root, "created-by-init");
    await initConfig(nestedRoot);
    assert.equal((await loadConfig(nestedRoot)).maxIterations, 10);

    const first = await loadConfig(root);
    first.sandbox.type = "local";
    const second = await loadConfig(root);
    assert.equal(second.sandbox.type, "docker");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("experiment storage rejects path traversal identifiers", () => {
  assert.throws(
    () => experimentDirectory("C:\\workspace", "..\\outside"),
    /Invalid experiment ID/,
  );
});

test("verified experiment evidence compiles into the companion wiki", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-wiki-"));
  try {
    const wikiRoot = path.join(root, "wiki-repository");
    await initWiki(wikiRoot);
    const missionPath = path.join(root, "mission.md");
    await writeFile(
      missionPath,
      `# Mission: Wiki Evidence

## Objective
Preserve verified experiment evidence.

## Success Metrics
- Experiments completed: >= 1
`,
      "utf8",
    );
    const mission = await loadMission(missionPath, root);
    mission.status = "active";
    const config = structuredClone(defaultConfig);
    config.analysis.mode = "rule-based";
    config.sandbox.type = "local";
    config.wikiPath = "wiki-repository";

    const cycle = await runExplorationCycle(mission, config, {
      root,
      approve: true,
    });
    const sync = await syncExperimentToWiki(
      mission,
      cycle.experiment!,
      cycle.reflection!,
      config,
      root,
    );

    assert.equal(sync?.status.sourceArtifacts, 1);
    assert.match(
      sync?.ingestion.artifact.content ?? "",
      /operations_per_second/,
    );
    const query = await queryWiki("deterministic local execution baseline", {
      root: wikiRoot,
    });
    assert.ok(query.matches.length > 0);
    assert.match(query.answer, /deterministic local execution baseline/i);
    assert.ok(
      query.matches.some(
        (match) =>
          match.path.startsWith("sources/") ||
          match.path.startsWith("wiki/sources/"),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Markdown references resume state and reject title collisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-mission-resume-"));
  try {
    const missionPath = path.join(root, "mission.md");
    await writeFile(
      missionPath,
      `# Mission: Stable State

## Objective
Preserve accumulated progress.
`,
      "utf8",
    );
    const mission = await loadMission(missionPath, root);
    mission.experimentIds.push("exp-existing");
    mission.successfulExperimentIds.push("exp-existing");
    mission.iteration = 1;
    await saveMissionState(mission, root);

    const resumed = await loadMissionForExecution(missionPath, root);
    assert.deepEqual(resumed.experimentIds, ["exp-existing"]);
    assert.equal(resumed.iteration, 1);
    resumed.status = "completed";
    assert.throws(
      () => resumeMissionState(mission, resumed),
      /already completed/,
    );
    resumed.status = "active";

    const backup = await backupMissionState(mission.id, root);
    assert.ok(backup);
    assert.match(await readFile(backup!, "utf8"), /exp-existing/);

    const collisionPath = path.join(root, "collision.md");
    await writeFile(
      collisionPath,
      `# Mission: Stable State

## Objective
This is a different mission with the same title.
`,
      "utf8",
    );
    await assert.rejects(
      () => loadMissionForExecution(collisionPath, root),
      /Mission ID collision/,
    );

    const explicitPath = path.join(root, "explicit.md");
    await writeFile(
      explicitPath,
      `# Mission: Stable State

**ID**: stable-state-alternative

## Objective
This is a different mission with an explicit ID.
`,
      "utf8",
    );
    assert.equal(
      (await loadMission(explicitPath, root)).id,
      "mission-stable-state-alternative",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
