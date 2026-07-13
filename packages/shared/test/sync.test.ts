import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createEmptyState,
  handoffAgent,
  loadState,
  onboardAgent,
  saveCheckpoint,
} from "../src/index.js";

test("checkpoint replaces mission queues but merges durable context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shared-merge-"));
  try {
    await saveCheckpoint(
      {
        mission: {
          progress: {
            nextActions: ["old"],
          },
        },
        context: {
          keyFindings: ["first"],
        },
      },
      root,
    );
    await saveCheckpoint(
      {
        mission: {
          progress: {
            nextActions: ["new"],
          },
        },
        context: {
          keyFindings: ["first", "second"],
        },
      },
      root,
    );

    const state = loadState(root)!;
    assert.deepEqual(state.mission.progress.nextActions, ["new"]);
    assert.deepEqual(state.context.keyFindings, ["first", "second"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent checkpoints preserve unique context entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shared-lock-"));
  try {
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        saveCheckpoint(
          {
            context: {
              keyFindings: [`finding-${index}`],
            },
          },
          root,
        ),
      ),
    );

    const state = loadState(root)!;
    assert.equal(state.context.keyFindings.length, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("onboard is local-only by default and returns a truthful summary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shared-onboard-"));
  try {
    await saveCheckpoint(
      {
        mission: {
          id: "mission-local",
          status: "active",
          progress: {
            phase: "execute",
            nextActions: ["run test"],
          },
        },
      },
      root,
    );

    const result = await onboardAgent({ projectRoot: root });
    assert.equal(result.isResume, true);
    assert.deepEqual(result.warnings, []);
    assert.match(result.summary ?? "", /mission-local/);
    assert.match(result.summary ?? "", /run test/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handoff checkpoints locally without creating Git side effects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shared-handoff-"));
  try {
    const initial = createEmptyState();
    await writeFile(
      path.join(root, ".agent-state.json"),
      `${JSON.stringify(initial, null, 2)}\n`,
      "utf8",
    );

    const result = await handoffAgent("paused", {}, root);
    assert.equal(result.stateCommitted, false);
    assert.equal(result.statePushed, false);
    assert.equal(result.state.session.endedAt !== undefined, true);

    const diskState = JSON.parse(
      await readFile(path.join(root, ".agent-state.json"), "utf8"),
    );
    assert.equal(diskState.mission.status, "paused");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint recovers a stale lock and creates missing roots", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "shared-stale-lock-"));
  const root = path.join(parent, "new-workspace");
  try {
    await saveCheckpoint({ context: { keyFindings: ["initial"] } }, root);
    const lockPath = path.join(root, ".agent-state.lock");
    await writeFile(lockPath, "stale", "utf8");
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);

    const state = await saveCheckpoint(
      { context: { keyFindings: ["recovered"] } },
      root,
    );
    assert.deepEqual(state.context.keyFindings, ["initial", "recovered"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
