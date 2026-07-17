import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  LlmProvider,
  LlmRequest,
  SearchProvider,
  SearchResult,
} from "@intelligent-agent-system/llm-wiki-compiler";
import { DEFAULT_READER_CONFIG, ResearchReader } from "../src/index.js";

const INTRO =
  "World representations predict future state for embodied robot control.";
const EXPERIMENT = "The robot completed 18 of 20 held-out control episodes.";

class E2eSearchProvider implements SearchProvider {
  readonly name = "e2e-search";

  async search(): Promise<SearchResult[]> {
    return [
      {
        id: "2607.12345v1",
        title: "Predictive World Representation",
        url: "https://arxiv.org/abs/2607.12345",
        abstract:
          "A predictive world representation for embodied robot control.",
        authors: ["Reader Test"],
        published: "2026-07-15",
        year: 2026,
        provider: this.name,
        arxivId: "2607.12345",
        versionId: "2607.12345v1",
        openAccess: true,
        fullTextLocations: [
          {
            url: "https://example.org/e2e-paper.txt",
            kind: "text",
            openAccess: true,
            source: this.name,
          },
        ],
      },
    ];
  }
}

class E2eLlmProvider implements LlmProvider {
  readonly name = "e2e-llm";

  async complete(request: LlmRequest) {
    switch (request.purpose) {
      case "screening":
        return response({
          relevance: 0.95,
          confidence: 0.9,
          difficultyEstimate: 6,
          reasons: ["Matches embodied robot control"],
        });
      case "source-analysis": {
        if (request.prompt.includes("Do not score importance")) {
          return response({
            paperType: "empirical",
            personalRelevance: 0.9,
            recommendation: "deep-read",
            estimatedReadMinutes: 20,
            strengths: ["Relevant abstract"],
            weaknesses: ["Full text unavailable"],
            prerequisites: ["robot control"],
            readingRoute: ["Acquire full text"],
          });
        }
        const unknown = {
          state: "unknown",
          confidence: 0,
          rationale: "Unavailable.",
          evidenceQuotes: [],
        };
        return response({
          paperType: "empirical",
          dimensions: {
            importance: {
              state: "assessed",
              score: 8,
              confidence: 0.9,
              rationale: "The source addresses predictive control.",
              evidenceQuotes: [INTRO],
            },
            novelty: unknown,
            methodology: {
              state: "assessed",
              score: 7,
              confidence: 0.8,
              rationale: "The source uses predictive world state.",
              evidenceQuotes: [INTRO],
            },
            experiments: {
              state: "assessed",
              score: 7,
              confidence: 0.8,
              rationale: "A held-out evaluation is reported.",
              evidenceQuotes: [EXPERIMENT],
            },
            reproducibility: unknown,
            writing: unknown,
            theory: unknown,
          },
          personalRelevance: 0.95,
          recommendation: "priority",
          estimatedReadMinutes: 40,
          strengths: ["Predictive mechanism"],
          weaknesses: ["Small evaluation"],
          criticalIssues: [],
          prerequisites: ["robot control"],
          readingRoute: ["Introduction", "Experiments"],
        });
      }
      case "relationship-analysis":
        return response({
          challenges: [
            {
              text: "The held-out evaluation is small.",
              severity: "medium",
              evidenceQuotes: [EXPERIMENT],
            },
          ],
        });
      case "query":
        return response({
          answer: "It predicts future state for control.",
          citations: [INTRO],
        });
      default:
        throw new Error(`Unexpected E2E LLM purpose: ${request.purpose}`);
    }
  }
}

function response(value: unknown) {
  return {
    text: JSON.stringify(value),
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

test("offline E2E completes the Research Reader knowledge loop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-e2e-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    await writeFile(
      path.join(root, ".research-reader-config.json"),
      `${JSON.stringify(
        {
          ...DEFAULT_READER_CONFIG,
          profile: {
            ...DEFAULT_READER_CONFIG.profile,
            learningEnabled: true,
            minimumExplicitFeedback: 2,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await reader.addSubscription({
      id: "e2e-subscription",
      name: "World representation",
      kind: "query",
      query: "world representation robot control",
      tags: ["robotics"],
    });
    const llm = new E2eLlmProvider();
    const tracked = await reader.track({
      approveNetwork: true,
      providers: [new E2eSearchProvider()],
      llmProvider: llm,
      maxLlmTokens: 50_000,
      now: new Date("2026-07-16T12:00:00Z"),
    });
    const paperId = tracked.papers[0]!.id;
    assert.equal(
      (await reader.dailyReport()).markdownPath.endsWith(".md"),
      true,
    );
    assert.equal(
      (await reader.updateProfile({ topics: ["world representation"] }))
        .explicit.topics[0]?.term,
      "world representation",
    );
    await reader.acquirePaper(paperId, {
      approveNetwork: true,
      fetch: async () =>
        new Response(
          `# Introduction

${INTRO}

# Experiments

${EXPERIMENT}
`,
          {
            status: 200,
            headers: { "content-type": "text/plain" },
          },
        ),
    });
    const review = await reader.reviewPaper(paperId, {
      level: "standard",
      llmProvider: llm,
      maxLlmTokens: 50_000,
      adversarial: true,
    });
    assert.ok(review.scientificQuality !== undefined);
    assert.equal(
      (await reader.createCalibration([paperId])).entries[0]?.paperId,
      paperId,
    );

    const session = await reader.startReading(
      paperId,
      "guided-read",
      "goal-oriented",
    );
    await reader.checkpointReading(session.id, {
      level: 1,
      userConfirmed: true,
      percent: 30,
    });
    await reader.checkpointReading(session.id, {
      level: 2,
      userConfirmed: true,
      percent: 90,
      understanding: 4,
      unresolvedQuestions: ["How does this transfer to hardware?"],
    });
    const answer = await reader.askPaper(
      paperId,
      "How is the representation used for control?",
      { llmProvider: llm, maxLlmTokens: 10_000 },
      session.id,
    );
    assert.equal(answer.citations[0]?.quote, INTRO);
    await reader.addNote(paperId, "The predictive state is the key mechanism.");
    await reader.completeReading(session.id);

    const sourceId = (await reader.getPaper(paperId))!.acquisition
      .fullTextSourceId!;
    await writeFile(
      path.join(root, "meta", "claims.json"),
      `${JSON.stringify(
        {
          version: 1,
          claims: [
            {
              id: "claim-e2e",
              sourceId,
              text: "World representations predict future state for control.",
              quote: INTRO,
            },
          ],
          topics: [
            {
              id: "planning",
              title: "Planning",
              claimIds: ["claim-e2e"],
            },
          ],
          sources: [
            {
              id: sourceId,
              title: "Predictive World Representation",
              path: "wiki/sources/e2e.md",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      path.join(root, "meta", "claim_graph.json"),
      `${JSON.stringify({ version: 1, edges: [] })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(root, "meta", "gaps.json"),
      `${JSON.stringify({
        version: 1,
        gaps: [{ description: "Robot control needs hardware evaluation." }],
      })}\n`,
      "utf8",
    );
    await reader.extractPaper(paperId, { recompile: false });
    await reader.recordFeedback({
      paperId,
      type: "quality-rating",
      explicit: true,
      value: 8,
    });
    await reader.recordFeedback({
      paperId,
      type: "personal-value",
      explicit: true,
      value: 9,
    });
    const profile = await reader.rebuildProfile();
    assert.equal(profile.learned.confidence, 1);
    assert.equal((await reader.evaluateCalibration()).status, "calibrated");
    assert.equal(
      (await reader.weeklyReport()).markdownPath.endsWith(".md"),
      true,
    );
    assert.ok((await reader.navigation()).nodes.length >= 3);
    const retention = await reader.createRetention(paperId, [
      "What does the representation predict?",
    ]);
    assert.equal((await reader.completeRetention(retention.id, [1])).score, 1);
    const survey = await reader.surveyPlan(
      "world representation robot control",
    );
    assert.deepEqual(survey.claimIds, ["claim-e2e"]);
    assert.equal((await reader.health()).recentFailures, 0);
    assert.match(
      await readFile(tracked.run.reportPath!, "utf8"),
      /Predictive World Representation/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
