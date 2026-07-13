import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runExplorationCycle } from "../src/exploration/cycle.js";
import { loadMission } from "../src/mission/manager.js";
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
      const config = structuredClone(defaultConfig);
      config.analysis.mode = "rule-based";
      config.sandbox.type = "docker";
      config.autoCompileWiki = false;

      const result = await runExplorationCycle(mission, config, { root });

      assert.equal(result.execution?.success, true);
      assert.equal(result.experiment?.status, "completed");
      assert.equal(result.decision.action, "complete");
      assert.equal(mission.successfulExperimentIds.length, 1);
      assert.equal(config.sandbox.docker?.networkMode, "none");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
