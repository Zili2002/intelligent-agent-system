import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ResearchReader,
  type DimensionAssessment,
  type PaperPassport,
  type PaperReview,
  type ReadingSession,
} from "../src/index.js";

function paper(id: string, sourceId: string, title: string): PaperPassport {
  const now = new Date().toISOString();
  return {
    version: 1,
    id,
    canonicalKey: `work:${id}:2026:reader`,
    sourceIds: [sourceId],
    metadata: {
      id,
      title,
      url: `https://example.org/${id}`,
      provider: "fixture",
      year: 2026,
    },
    discovery: [],
    acquisition: { status: "metadata-only" },
    triage: {
      relevanceScore: 0.8,
      confidence: 0.8,
      recommendation: "priority",
      reasons: ["robot planning"],
      profileVersion: "profile",
      policyVersion: "triage-v1",
    },
    reading: {
      status: "read",
      priority: 80,
      userTags: ["robotics"],
      understandingScore: 4,
    },
    reviewIds: [],
    knowledge: {
      compiled: true,
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

function review(paperId: string): PaperReview {
  const unknown = (): DimensionAssessment => ({
    state: "unknown",
    confidence: 0,
    rationale: "Unavailable.",
    evidence: [],
  });
  return {
    version: 1,
    id: `review-${paperId}`,
    paperId,
    sourceId: "source",
    level: "fast",
    paperType: "other",
    coverage: {
      fullText: false,
      sections: ["abstract"],
      pages: [],
      coverageScore: 0.1,
    },
    dimensions: {
      importance: unknown(),
      novelty: unknown(),
      methodology: unknown(),
      experiments: unknown(),
      reproducibility: unknown(),
      writing: unknown(),
      theory: unknown(),
    },
    evidenceConfidence: 0.1,
    personalRelevance: 0.9,
    recommendation: "priority",
    strengths: [],
    weaknesses: [],
    criticalIssues: ["Evaluation scope is narrow."],
    prerequisites: ["predictive control"],
    readingRoute: [],
    adversarialChallenges: [],
    unresolvedChallenges: [],
    model: "fixture",
    promptVersion: "fixture",
    createdAt: new Date().toISOString(),
  };
}

test("navigation graph and reading paths connect papers, claims, topics, and prerequisites", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-navigation-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    await reader.savePaper(
      paper("paper-one", "source-one", "World Model Robot Planning"),
    );
    await reader.saveReview(review("paper-one"));
    await writeFile(
      path.join(root, "meta", "claims.json"),
      `${JSON.stringify({
        version: 1,
        claims: [
          {
            id: "claim-one",
            sourceId: "source-one",
            text: "World models support robot planning.",
            quote: "World models support robot planning.",
          },
        ],
        topics: [
          {
            id: "planning",
            title: "Planning",
            claimIds: ["claim-one"],
          },
        ],
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(root, "meta", "claim_graph.json"),
      `${JSON.stringify({
        version: 1,
        edges: [
          {
            from: "claim-one",
            to: "claim-one",
            type: "supports",
          },
        ],
      })}\n`,
      "utf8",
    );
    const graph = await reader.navigation();
    assert.ok(graph.nodes.some((node) => node.id === "paper-one"));
    assert.ok(graph.nodes.some((node) => node.id === "claim-one"));
    assert.ok(graph.nodes.some((node) => node.id === "topic:planning"));
    assert.ok(
      graph.edges.some(
        (edge) =>
          edge.from === "paper-one" &&
          edge.to === "prerequisite:predictive-control",
      ),
    );
    const readingPath = await reader.readingPath("robot planning");
    assert.deepEqual(readingPath.paperIds, ["paper-one"]);
    assert.deepEqual(readingPath.prerequisites, ["predictive control"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analytics and dialogue health use only persisted explicit session evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-analytics-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    await reader.savePaper(
      paper("paper-one", "source-one", "World Model Robot Planning"),
    );
    await reader.saveReview(review("paper-one"));
    const now = new Date().toISOString();
    const session: ReadingSession = {
      version: 1,
      id: "session-health",
      paperId: "paper-one",
      mode: "guided-read",
      intent: "exploratory",
      status: "completed",
      checkpoints: [
        { level: 1, userConfirmed: true, completedAt: now },
        { level: 2, userConfirmed: true, completedAt: now },
      ],
      progress: { percent: 100 },
      questions: Array.from({ length: 5 }, (_, index) => ({
        question: `Question ${index}`,
        answer: "Yes, the claim is accepted.",
        citations: [],
      })),
      selfAssessment: {
        understanding: 4,
        unresolvedQuestions: [],
      },
      createdAt: now,
      updatedAt: now,
    };
    await reader.saveSession(session);
    const analytics = await reader.analytics();
    assert.equal(analytics.averageExplicitUnderstanding, 4);
    assert.equal(analytics.sessionsByMode["guided-read"], 1);
    const health = await reader.dialogueHealth();
    assert.ok(
      health.signals.some((signal) => signal.type === "persistent-agreement"),
    );
    assert.ok(
      health.signals.some((signal) => signal.type === "conflict-avoidance"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reasoning patterns, retention checks, and survey plans are persistent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-survey-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    await reader.savePaper(
      paper("paper-one", "source-one", "World Model Robot Planning"),
    );
    assert.ok((await reader.patterns()).length >= 4);
    const retention = await reader.createRetention("paper-one", [
      "What does the world model predict?",
      "What limits the evaluation?",
    ]);
    const completed = await reader.completeRetention(retention.id, [1, 0.5]);
    assert.equal(completed.score, 0.75);
    assert.equal((await reader.retentionChecks()).length, 1);
    await writeFile(
      path.join(root, "meta", "claims.json"),
      `${JSON.stringify({
        version: 1,
        claims: [
          {
            id: "claim-one",
            sourceId: "source-one",
            text: "World models support robot planning.",
            quote: "World models support robot planning.",
          },
        ],
        topics: [
          {
            id: "planning",
            title: "Planning",
            claimIds: ["claim-one"],
          },
        ],
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(root, "meta", "gaps.json"),
      `${JSON.stringify({
        version: 1,
        gaps: [{ description: "Robot planning lacks real-world evaluation." }],
      })}\n`,
      "utf8",
    );
    const survey = await reader.surveyPlan("world model robot planning");
    assert.deepEqual(survey.paperIds, ["paper-one"]);
    assert.deepEqual(survey.claimIds, ["claim-one"]);
    assert.match(
      await readFile(survey.markdownPath, "utf8"),
      /Evidence matrix/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
