import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  admitEvidenceClues,
  completeEvidenceClue,
  getEvidenceFrontierStatus,
  initWiki,
  selectEvidenceClues,
  type EmbeddingProvider,
} from "../src/index.js";

const roots: string[] = [];

async function workspace(
  overrides: Partial<{
    maxFrontierItems: number;
    maxPendingPerTarget: number;
    maxActivePerProblem: number;
    maxActivePerTopic: number;
    maxQueriesPerCycle: number;
    maxAttempts: number;
    clueTtlDays: number;
    baseCooldownMinutes: number;
    semanticClueDedupThreshold: number;
    highWatermarkPercent: number;
    criticalWatermarkPercent: number;
    highWatermarkMinPriority: number;
    criticalWatermarkMinPriority: number;
    noNoveltyCircuitBreaker: number;
    noNoveltyCooldownHours: number;
    maxTerminalFrontierItems: number;
    maxFrontierHistoryItems: number;
    refreshIntervalHours: number;
  }> = {},
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-frontier-"));
  roots.push(root);
  await initWiki(root);
  const configPath = path.join(root, ".llmwiki-config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  Object.assign(config.lifecycle, {
    semanticClueDedupThreshold: 1,
    ...overrides,
  });
  await writeFile(configPath, JSON.stringify(config));
  return root;
}

after(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("Evidence Frontier globally deduplicates queries and enforces per-target caps", async () => {
  const root = await workspace({ maxPendingPerTarget: 2 });
  await admitEvidenceClues(
    [
      {
        query: "Agent recovery evidence",
        targetId: "a",
        kind: "gap",
        priority: 50,
      },
      {
        query: " agent recovery   evidence ",
        targetId: "b",
        kind: "support",
        priority: 70,
      },
      { query: "Second query", targetId: "a", kind: "gap", priority: 40 },
      { query: "Third query", targetId: "a", kind: "gap", priority: 30 },
    ],
    { root },
  );
  const status = await getEvidenceFrontierStatus({ root });
  assert.equal(status.items, 2);
  assert.equal(status.admittedTotal, 2);
  assert.equal(status.deduplicatedTotal, 1);
  assert.equal(status.prunedTotal, 1);
});

test("Evidence Frontier selects diverse targets and applies bounded retry cooldown", async () => {
  const start = new Date("2026-07-15T00:00:00.000Z");
  const root = await workspace({
    maxQueriesPerCycle: 2,
    maxAttempts: 2,
    baseCooldownMinutes: 60,
  });
  const admitted = await admitEvidenceClues(
    [
      { query: "query one", targetId: "a", kind: "gap", priority: 90 },
      { query: "query two", targetId: "a", kind: "gap", priority: 80 },
      { query: "query three", targetId: "b", kind: "gap", priority: 70 },
    ],
    { root, now: () => start },
  );
  const first = await selectEvidenceClues({
    root,
    limit: 10,
    now: () => start,
  });
  assert.deepEqual(
    first.clues.map((clue) => clue.query),
    ["query one", "query three"],
  );
  await completeEvidenceClue(
    first.clues[0]!.id,
    { resultCount: 0, importedCount: 0, error: "temporary failure" },
    { root, now: () => start },
  );
  await completeEvidenceClue(
    first.clues[1]!.id,
    { resultCount: 2, importedCount: 1 },
    { root, now: () => start },
  );
  const immediate = await selectEvidenceClues({
    root,
    limit: 2,
    now: () => start,
  });
  assert.deepEqual(
    immediate.clues.map((clue) => clue.query),
    ["query two"],
  );
  await completeEvidenceClue(
    immediate.clues[0]!.id,
    { resultCount: 1, importedCount: 0 },
    { root, now: () => start },
  );
  const retryTime = new Date(start.getTime() + 61 * 60_000);
  const retry = await selectEvidenceClues({
    root,
    limit: 2,
    now: () => retryTime,
  });
  assert.equal(retry.clues[0]?.id, admitted.clues[0]?.id);
  const final = await completeEvidenceClue(
    retry.clues[0]!.id,
    { resultCount: 0, importedCount: 0, error: "permanent failure" },
    { root, now: () => retryTime },
  );
  assert.equal(final.rejected, 1);
});

test("Evidence Frontier backpressure retains higher-priority clues at capacity", async () => {
  const root = await workspace({
    maxFrontierItems: 10,
    highWatermarkPercent: 99,
    criticalWatermarkPercent: 100,
    highWatermarkMinPriority: 0,
    criticalWatermarkMinPriority: 0,
  });
  await admitEvidenceClues(
    Array.from({ length: 15 }, (_, index) => ({
      query: `capacity query ${index}`,
      targetId: `target-${index}`,
      kind: "manual" as const,
      priority: index,
    })),
    { root },
  );
  const status = await getEvidenceFrontierStatus({ root });
  assert.equal(status.items, 10);
  assert.equal(status.prunedTotal, 5);
  const artifact = JSON.parse(
    await readFile(path.join(root, "meta", "evidence_frontier.json"), "utf8"),
  );
  assert.equal(
    Math.min(
      ...artifact.items.map((item: { priority: number }) => item.priority),
    ),
    5,
  );
});

test("Evidence Frontier reopens unresolved refresh work after a prior resolved search", async () => {
  const root = await workspace();
  const admitted = await admitEvidenceClues(
    [
      {
        query: "paper v2 full text",
        targetId: "source-a",
        kind: "refresh",
        priority: 100,
      },
    ],
    { root },
  );
  const selected = await selectEvidenceClues({
    root,
    ids: [admitted.clues[0]!.id],
  });
  await completeEvidenceClue(
    selected.clues[0]!.id,
    { resultCount: 2, importedCount: 0 },
    { root },
  );
  const reopened = await admitEvidenceClues(
    [
      {
        query: "paper v2 full text",
        targetId: "source-a",
        kind: "refresh",
        priority: 100,
      },
    ],
    { root },
  );
  assert.equal(reopened.clues[0]?.status, "pending");
  assert.equal(reopened.clues[0]?.attempts, 0);
});

test("Evidence Frontier semantically merges paraphrases without merging opposing intents", async () => {
  const root = await workspace({ semanticClueDedupThreshold: 0.9 });
  const embeddings: EmbeddingProvider = {
    model: "fake-frontier",
    async embed(texts) {
      return texts.map((text) =>
        /recover|recovery/i.test(text) ? [1, 0] : [0, 1],
      );
    },
  };
  const configPath = path.join(root, ".llmwiki-config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.retrieval.embeddingModel = embeddings.model;
  await writeFile(configPath, JSON.stringify(config));
  const result = await admitEvidenceClues(
    [
      {
        query: "agent recovery after tool failure",
        targetId: "claim-a",
        kind: "support",
        priority: 60,
      },
      {
        query: "how agents recover when a tool fails",
        targetId: "claim-b",
        kind: "support",
        priority: 70,
      },
      {
        query: "agent recovery after tool failure",
        targetId: "claim-a",
        kind: "challenge",
        priority: 80,
      },
    ],
    { root, embeddingProvider: embeddings },
  );
  assert.equal(result.status.items, 2);
  assert.equal(result.status.semanticDeduplicatedTotal, 1);
  assert.deepEqual(result.clues[0]?.targetIds, ["claim-a", "claim-b"]);
});

test("Evidence Frontier enforces problem, topic, and watermark admission budgets", async () => {
  const root = await workspace({
    maxFrontierItems: 10,
    maxActivePerProblem: 1,
    maxActivePerTopic: 2,
    highWatermarkPercent: 70,
    criticalWatermarkPercent: 90,
    highWatermarkMinPriority: 70,
    criticalWatermarkMinPriority: 95,
  });
  const constrained = await admitEvidenceClues(
    [
      {
        query: "problem one",
        targetId: "a",
        problemId: "problem-a",
        topicId: "topic-a",
        kind: "manual",
        priority: 50,
      },
      {
        query: "same problem",
        targetId: "b",
        problemId: "problem-a",
        topicId: "topic-b",
        kind: "manual",
        priority: 60,
      },
      {
        query: "same topic one",
        targetId: "c",
        problemId: "problem-c",
        topicId: "topic-a",
        kind: "manual",
        priority: 60,
      },
      {
        query: "same topic two",
        targetId: "d",
        problemId: "problem-d",
        topicId: "topic-a",
        kind: "manual",
        priority: 60,
      },
    ],
    { root },
  );
  assert.equal(constrained.status.items, 2);

  await admitEvidenceClues(
    Array.from({ length: 5 }, (_, index) => ({
      query: `fill ${index}`,
      targetId: `fill-${index}`,
      problemId: `fill-${index}`,
      topicId: `fill-${index}`,
      kind: "manual" as const,
      priority: 60,
    })),
    { root },
  );
  const throttled = await admitEvidenceClues(
    [
      {
        query: "low at high watermark",
        targetId: "low",
        kind: "manual",
        priority: 69,
      },
      {
        query: "high at high watermark",
        targetId: "high",
        kind: "manual",
        priority: 90,
      },
      {
        query: "another high",
        targetId: "high-two",
        kind: "manual",
        priority: 90,
      },
      {
        query: "below critical",
        targetId: "critical-low",
        kind: "manual",
        priority: 94,
      },
      {
        query: "refresh bypass",
        targetId: "refresh",
        kind: "refresh",
        priority: 1,
      },
    ],
    { root },
  );
  assert.equal(throttled.status.activeItems, 10);
  assert.equal(throttled.status.admissionMode, "critical");
  assert.ok(throttled.clues.some((clue) => clue.query === "refresh bypass"));
  assert.ok(
    !throttled.clues.some(
      (clue) =>
        clue.query === "low at high watermark" ||
        clue.query === "below critical",
    ),
  );
});

test("Evidence Frontier prioritizes information gain and circuit-breaks no-novelty refreshes", async () => {
  const start = new Date("2026-07-16T00:00:00.000Z");
  const root = await workspace({
    maxQueriesPerCycle: 1,
    maxAttempts: 3,
    noNoveltyCircuitBreaker: 2,
    noNoveltyCooldownHours: 24,
  });
  const admitted = await admitEvidenceClues(
    [
      {
        query: "manual broad search",
        targetId: "manual",
        kind: "manual",
        priority: 100,
      },
      {
        query: "exact new version",
        targetId: "source-a",
        kind: "refresh",
        priority: 50,
      },
    ],
    { root, now: () => start },
  );
  const first = await selectEvidenceClues({
    root,
    now: () => start,
  });
  assert.equal(first.clues[0]?.kind, "refresh");
  await completeEvidenceClue(
    first.clues[0]!.id,
    { resultCount: 3, importedCount: 0 },
    { root, now: () => start },
  );
  await admitEvidenceClues(
    [
      {
        query: "exact new version",
        targetId: "source-a",
        kind: "refresh",
        priority: 50,
      },
    ],
    { root, now: () => start },
  );
  const second = await selectEvidenceClues({
    root,
    ids: [admitted.clues[1]!.id],
    now: () => start,
  });
  const circuit = await completeEvidenceClue(
    second.clues[0]!.id,
    { resultCount: 2, importedCount: 0 },
    { root, now: () => start },
  );
  assert.equal(circuit.deferred, 1);
  assert.equal(circuit.circuitBrokenTotal, 1);
});

test("Evidence Frontier compacts terminal history and serializes concurrent admissions", async () => {
  const root = await workspace({
    maxFrontierItems: 10,
    maxTerminalFrontierItems: 2,
    maxFrontierHistoryItems: 20,
    highWatermarkPercent: 99,
    criticalWatermarkPercent: 100,
    highWatermarkMinPriority: 0,
    criticalWatermarkMinPriority: 0,
  });
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      admitEvidenceClues(
        [
          {
            query: `concurrent ${index}`,
            targetId: `target-${index}`,
            kind: "manual",
            priority: index,
          },
        ],
        { root },
      ),
    ),
  );
  const bounded = await getEvidenceFrontierStatus({ root });
  assert.equal(bounded.activeItems, 10);
  const selected = await selectEvidenceClues({ root, limit: 10 });
  for (const clue of selected.clues) {
    await completeEvidenceClue(
      clue.id,
      { resultCount: 1, importedCount: 1 },
      { root },
    );
  }
  const compacted = await getEvidenceFrontierStatus({ root });
  assert.equal(compacted.resolved, 2);
  assert.ok(compacted.historyItems >= 8);
  assert.equal(compacted.compactedTotal, 8);
});
