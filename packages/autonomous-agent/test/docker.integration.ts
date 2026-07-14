import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadMission,
  loadMissionForExecution,
  saveMissionState,
} from "../src/mission/manager.js";
import { runContinuousMission } from "../src/runtime/scheduler.js";
import { defaultConfig } from "../src/types/config.js";

test(
  "Docker sandbox executes a generated experiment with network disabled",
  { timeout: 120_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-docker-"));
    try {
      const missionPath = path.join(root, "mission.md");
      await writeFile(
        missionPath,
        `# Mission: Docker Integration

## Objective
Execute one deterministic experiment in the Docker sandbox.

## Success Metrics
- Experiments completed: >= 1

## Constraints
- Safety: No network access
`,
        "utf8",
      );
      const mission = await loadMission(missionPath, root);
      mission.status = "active";
      await saveMissionState(mission, root);
      const config = structuredClone(defaultConfig);
      config.analysis.mode = "rule-based";
      config.sandbox.type = "docker";
      config.autoCompileWiki = false;

      const run = await runContinuousMission(mission.id, config, {
        root,
        intervalMs: 0,
        maxDurationMs: 120_000,
        maxCycles: 2,
        retry: {
          maxAttempts: 2,
          initialDelayMs: 100,
          maxDelayMs: 500,
        },
      });
      const completedMission = await loadMissionForExecution(mission.id, root, {
        allowCompleted: true,
      });

      assert.equal(run.status, "completed");
      assert.equal(run.cycles, 1);
      assert.equal(completedMission.successfulExperimentIds.length, 1);
      assert.equal(config.sandbox.docker?.networkMode, "none");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
