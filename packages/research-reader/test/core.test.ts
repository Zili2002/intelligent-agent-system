import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_READER_CONFIG,
  ResearchReader,
  type DimensionAssessment,
  type PaperPassport,
  type PaperReview,
  type ReaderSubscription,
  type ReadingSession,
} from "../src/index.js";

function unknownDimension(): DimensionAssessment {
  return {
    state: "unknown",
    confidence: 0,
    rationale: "The required section is not available.",
    evidence: [],
  };
}

function passport(id = "paper-1"): PaperPassport {
  const now = new Date().toISOString();
  return {
    version: 1,
    id,
    canonicalKey: "arxiv:2401.00001",
    sourceIds: [],
    metadata: {
      id: "2401.00001",
      title: "Evidence Grounded Reading",
      url: "https://arxiv.org/abs/2401.00001",
      provider: "arxiv",
      arxivId: "2401.00001",
      authors: ["Ada Reader"],
      published: "2024-01-01",
      year: 2024,
    },
    discovery: [
      {
        query: "evidence grounded reading",
        provider: "arxiv",
        runId: "run-1",
        discoveredAt: now,
      },
    ],
    acquisition: { status: "metadata-only" },
    reading: {
      status: "unread",
      priority: 50,
      userTags: [],
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

function review(): PaperReview {
  return {
    version: 1,
    id: "review-1",
    paperId: "paper-1",
    sourceId: "source-1",
    level: "fast",
    paperType: "other",
    coverage: {
      fullText: false,
      sections: ["abstract"],
      pages: [],
      coverageScore: 0.1,
    },
    dimensions: {
      importance: unknownDimension(),
      novelty: unknownDimension(),
      methodology: unknownDimension(),
      experiments: unknownDimension(),
      reproducibility: unknownDimension(),
      writing: unknownDimension(),
      theory: unknownDimension(),
    },
    evidenceConfidence: 0.1,
    personalRelevance: 0.8,
    recommendation: "skim",
    strengths: [],
    weaknesses: [],
    criticalIssues: [],
    prerequisites: [],
    readingRoute: [],
    adversarialChallenges: [],
    unresolvedChallenges: [],
    model: "test-provider",
    promptVersion: "reader-fast-v1",
    createdAt: new Date().toISOString(),
  };
}

test("initialization creates versioned Reader state without enabling effects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-init-"));
  try {
    const reader = new ResearchReader({ root });
    const first = await reader.init();
    const second = await reader.init();
    assert.equal(first.createdConfig, true);
    assert.equal(second.createdConfig, false);
    assert.equal(first.status.schemaVersion, 1);
    assert.equal(first.status.papers, 0);
    assert.equal((await reader.getSubscriptions()).items.length, 0);
    assert.equal((await reader.getProfile()).learned.confidence, 0);
    const config = JSON.parse(
      await readFile(path.join(root, ".research-reader-config.json"), "utf8"),
    );
    assert.equal(config.tracking.enabled, false);
    assert.equal(config.review.autoFastReview, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Reader rejects configuration paths that escape the Wiki root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-config-"));
  try {
    await writeFile(
      path.join(root, ".research-reader-config.json"),
      `${JSON.stringify(
        { ...DEFAULT_READER_CONFIG, metaPath: "../outside" },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await assert.rejects(
      () => new ResearchReader({ root }).status(),
      /must stay inside/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Paper Passports persist and enforce reading state transitions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-paper-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    await reader.savePaper(passport());
    assert.equal((await reader.listPapers()).length, 1);
    assert.equal(
      (await reader.markPaper("paper-1", "queued")).reading.status,
      "queued",
    );
    assert.equal(
      (await reader.markPaper("paper-1", "reading")).reading.status,
      "reading",
    );
    assert.equal(
      (await reader.markPaper("paper-1", "read")).reading.status,
      "read",
    );
    await assert.rejects(
      () => reader.markPaper("paper-1", "queued"),
      /Invalid reading transition/,
    );
    await assert.rejects(
      () => reader.savePaper(passport("../escape")),
      /unsafe characters/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Reviews, sessions, profiles, and subscriptions round-trip", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-artifacts-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    await reader.savePaper(passport());
    await reader.saveReview(review());
    assert.deepEqual((await reader.getPaper("paper-1"))?.reviewIds, [
      "review-1",
    ]);
    assert.equal((await reader.listReviews("paper-1")).length, 1);

    const now = new Date().toISOString();
    const session: ReadingSession = {
      version: 1,
      id: "session-1",
      paperId: "paper-1",
      mode: "guided-read",
      intent: "exploratory",
      status: "active",
      checkpoints: [
        {
          level: 1,
          userConfirmed: false,
        },
      ],
      progress: {},
      questions: [],
      createdAt: now,
      updatedAt: now,
    };
    await reader.saveSession(session);
    assert.equal((await reader.getSession("session-1"))?.mode, "guided-read");

    const profile = await reader.getProfile();
    profile.explicit.topics.push({ term: "robotics", weight: 1 });
    await reader.saveProfile(profile);
    assert.equal(
      (await reader.getProfile()).explicit.topics[0]?.term,
      "robotics",
    );

    const subscriptions = await reader.getSubscriptions();
    const subscription: ReaderSubscription = {
      version: 1,
      id: "subscription-1",
      name: "Robotics",
      enabled: true,
      kind: "query",
      query: "robotics",
      weight: 1,
      tags: ["robotics"],
      preferredLanguages: ["en"],
      createdAt: now,
      updatedAt: now,
    };
    subscriptions.items.push(subscription);
    await reader.saveSubscriptions(subscriptions);
    assert.equal((await reader.getSubscriptions()).items[0]?.query, "robotics");

    const status = await reader.status();
    assert.equal(status.papers, 1);
    assert.equal(status.reviews, 1);
    assert.equal(status.sessions, 1);
    assert.equal(status.subscriptions, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Unavailable Review dimensions cannot carry fabricated scores", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-review-guard-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    await reader.savePaper(passport());
    const invalid = review();
    invalid.dimensions.experiments = {
      state: "unknown",
      score: 8,
      confidence: 0,
      rationale: "No experiment section was supplied.",
      evidence: [],
    };
    await assert.rejects(
      () => reader.saveReview(invalid),
      /cannot score an unavailable dimension/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Reader managed paths reject symlink and junction escapes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "reader-outside-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    const papersDir = path.join(root, "meta", "reader", "papers");
    await rm(papersDir, { recursive: true, force: true });
    await mkdir(outside, { recursive: true });
    try {
      await symlink(
        outside,
        papersDir,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        t.skip("Symlink creation is unavailable in this environment");
        return;
      }
      throw error;
    }
    await assert.rejects(() => reader.status(), /symbolic link|outside/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
