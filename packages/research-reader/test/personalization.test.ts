import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ingestContent } from "@intelligent-agent-system/llm-wiki-compiler";
import {
  DEFAULT_READER_CONFIG,
  ResearchReader,
  approveRequest,
  checkReaderHealth,
  consumeApprovedRequest,
  ensureApprovalRequest,
  listApprovalRequests,
  loadReaderConfig,
  recoverInterruptedTrackingRuns,
  runReaderDaemon,
  type DimensionAssessment,
  type PaperPassport,
  type PaperReview,
  type ReaderTrackResult,
} from "../src/index.js";

function passport(id = "paper-profile"): PaperPassport {
  const now = new Date().toISOString();
  return {
    version: 1,
    id,
    canonicalKey: `work:${id}:2026:reader`,
    sourceIds: [],
    metadata: {
      id,
      title: "Robotics Planning and World Models",
      url: `https://example.org/${id}`,
      provider: "fixture",
      year: 2026,
    },
    discovery: [],
    acquisition: { status: "metadata-only" },
    reading: {
      status: "read",
      priority: 80,
      userTags: ["robotics", "planning"],
      understandingScore: 5,
    },
    reviewIds: [],
    knowledge: {
      compiled: false,
      claimIds: [],
      wikiPaths: [],
    },
    lifecycle: {
      reviewStale: false,
      retracted: false,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function assessedDimension(
  sourceId: string,
  quote: string,
): DimensionAssessment {
  return {
    state: "assessed",
    score: 8,
    confidence: 0.8,
    rationale: "Fixture assessment.",
    evidence: [
      {
        sourceId,
        quote,
        start: 0,
        end: quote.length,
      },
    ],
  };
}

function review(
  sourceId: string,
  quote: string,
  paperId = "paper-profile",
): PaperReview {
  const unknown = (): DimensionAssessment => ({
    state: "unknown",
    confidence: 0,
    rationale: "Unavailable.",
    evidence: [],
  });
  return {
    version: 1,
    id: "review-profile",
    paperId,
    sourceId,
    level: "standard",
    paperType: "empirical",
    coverage: {
      fullText: true,
      sections: ["introduction"],
      pages: [],
      coverageScore: 0.5,
    },
    dimensions: {
      importance: assessedDimension(sourceId, quote),
      novelty: unknown(),
      methodology: unknown(),
      experiments: unknown(),
      reproducibility: unknown(),
      writing: unknown(),
      theory: unknown(),
    },
    scientificQuality: 8,
    evidenceConfidence: 0.4,
    personalRelevance: 0.9,
    recommendation: "priority",
    strengths: [],
    weaknesses: [],
    criticalIssues: [],
    prerequisites: [],
    readingRoute: [],
    adversarialChallenges: [],
    unresolvedChallenges: [],
    model: "fixture",
    promptVersion: "fixture-v1",
    createdAt: new Date().toISOString(),
  };
}

async function enableLearning(root: string): Promise<void> {
  await writeFile(
    path.join(root, ".research-reader-config.json"),
    `${JSON.stringify(
      {
        ...DEFAULT_READER_CONFIG,
        profile: {
          ...DEFAULT_READER_CONFIG.profile,
          learningEnabled: true,
          minimumExplicitFeedback: 2,
          maximumLearnedWeightChange: 0.1,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

test("feedback is append-only and Profile learning is bounded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-profile-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    await enableLearning(root);
    await reader.savePaper(passport());
    await reader.recordFeedback({
      paperId: "paper-profile",
      type: "quality-rating",
      explicit: true,
      value: 8,
    });
    await reader.recordFeedback({
      paperId: "paper-profile",
      type: "personal-value",
      explicit: true,
      value: 9,
    });
    await reader.recordFeedback({
      paperId: "paper-profile",
      type: "question-topic",
      explicit: false,
      topics: ["latent planning"],
    });
    assert.equal((await reader.listFeedback()).length, 3);
    const profile = await reader.rebuildProfile();
    assert.equal(profile.learned.sampleCount, 2);
    assert.equal(profile.learned.confidence, 1);
    assert.ok(profile.learned.topics.length > 0);
    assert.ok(profile.learned.topics.every((item) => item.weight <= 0.1));
    assert.ok(profile.learned.strongAreas.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("calibration separates objective quality from personal preference", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-calibration-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    await enableLearning(root);
    await reader.savePaper(passport());
    const quote = "Fixture evidence.";
    const source = await ingestContent(quote, "fixture-review.txt", {
      root,
      title: "Fixture Review",
    });
    const storedPaper = await reader.getPaper("paper-profile");
    storedPaper!.sourceIds.push(source.artifact.id);
    storedPaper!.acquisition = {
      status: "available",
      fullTextSourceId: source.artifact.id,
    };
    await reader.savePaper(storedPaper!);
    await reader.saveReview(review(source.artifact.id, quote));
    await reader.recordFeedback({
      paperId: "paper-profile",
      type: "quality-rating",
      explicit: true,
      value: 7,
    });
    await reader.recordFeedback({
      paperId: "paper-profile",
      type: "personal-value",
      explicit: true,
      value: 10,
    });
    const evaluation = await reader.evaluateCalibration();
    assert.equal(evaluation.status, "calibrated");
    assert.equal(evaluation.objectiveSamples, 1);
    assert.equal(evaluation.preferenceSamples, 1);
    assert.equal(evaluation.objective?.meanAbsoluteError, 1);
    assert.equal(evaluation.preference?.meanAbsoluteError, 1);
    assert.equal((await reader.calibration())?.status, "calibrated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("weekly and trend reports are deterministic local artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-weekly-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    await reader.savePaper(passport());
    const weekly = await reader.weeklyReport();
    const trends = await reader.trendReport();
    assert.match(
      await readFile(weekly.markdownPath, "utf8"),
      /Papers tracked: 1/,
    );
    assert.match(await readFile(trends.markdownPath, "utf8"), /robotics/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approval requests are audited, redacted, approved, and consumed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-approval-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    const config = await loadReaderConfig(root);
    const request = await ensureApprovalRequest(
      config,
      "network",
      "Approve provider access",
      {
        credential: "ANTHROPIC_AUTH_TOKEN=secret-value",
        apiKey: "plain-structured-secret",
      },
    );
    const stored = await readFile(
      path.join(config.approvalsDir, `${request.id}.json`),
      "utf8",
    );
    assert.equal(stored.includes("secret-value"), false);
    assert.equal(stored.includes("plain-structured-secret"), false);
    const decisions = await Promise.allSettled([
      approveRequest(config, request.id, "reviewer-one"),
      approveRequest(config, request.id, "reviewer-two"),
    ]);
    assert.equal(
      decisions.filter((decision) => decision.status === "fulfilled").length,
      1,
    );
    assert.equal((await listApprovalRequests(config, "approved")).length, 1);
    assert.equal(
      (await consumeApprovedRequest(config, "network"))?.status,
      "consumed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon waits for approval, consumes it, retries, and recovers interrupted runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-daemon-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    const config = await loadReaderConfig(root);
    let clock = Date.parse("2026-07-16T00:00:00Z");
    const waiting = await runReaderDaemon(config, {
      intervalMs: 10,
      maxDurationMs: 100,
      maxCycles: 2,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2 },
      clock: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      trackStep: async () => {
        throw new Error("must not run before approval");
      },
    });
    assert.equal(waiting.status, "waiting-approval");
    const request = (await listApprovalRequests(config, "pending"))[0]!;
    await approveRequest(config, request.id, "reviewer");

    let attempts = 0;
    const completed = await runReaderDaemon(config, {
      intervalMs: 10,
      maxDurationMs: 100,
      maxCycles: 2,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2 },
      clock: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      trackStep: async (): Promise<ReaderTrackResult> => {
        attempts += 1;
        if (attempts === 1) throw new Error("HTTP 503 temporary failure");
        return {
          run: {
            version: 1,
            id: `reader-run-${attempts}`,
            type: "tracking",
            status: "completed",
            startedAt: new Date(clock).toISOString(),
            completedAt: new Date(clock).toISOString(),
            durationMs: 1,
            subscriptions: 1,
            searches: 1,
            candidates: 1,
            created: 1,
            updated: 0,
            errors: [],
          },
          papers: [],
          candidates: [],
        };
      },
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.cycles, 2);
    assert.equal(completed.attempts, 3);

    await writeFile(
      path.join(config.runsDir, "reader-run-interrupted.json"),
      `${JSON.stringify({
        version: 1,
        id: "reader-run-interrupted",
        type: "tracking",
        status: "running",
        startedAt: "2026-07-15T00:00:00.000Z",
        subscriptions: 1,
        searches: 0,
        candidates: 0,
        created: 0,
        updated: 0,
        errors: [],
      })}\n`,
      "utf8",
    );
    assert.equal(
      (await recoverInterruptedTrackingRuns(config, new Date(clock))).length,
      1,
    );
    const health = await checkReaderHealth(config);
    assert.equal(health.interruptedRuns, 1);
    assert.equal(JSON.stringify(health).includes("secret-value"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
