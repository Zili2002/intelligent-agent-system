import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  LlmProvider,
  LlmRequest,
  SearchProvider,
  SearchResult,
} from "@intelligent-agent-system/llm-wiki-compiler";
import {
  ResearchReader,
  type DimensionAssessment,
  type PaperReview,
} from "../src/index.js";

class FixtureSearchProvider implements SearchProvider {
  readonly name = "fixture";
  version = 1;
  calls = 0;

  async search(
    query: string,
    _options: { limit: number; signal?: AbortSignal },
  ): Promise<SearchResult[]> {
    this.calls += 1;
    return [
      {
        id: `2407.00001v${this.version}`,
        title: "World Representation for Embodied Robotics",
        url: "https://arxiv.org/abs/2407.00001",
        abstract: `A ${query} method for embodied robotics and predictive control.`,
        authors: ["Ada Robot"],
        published: "2026-07-15",
        year: 2026,
        provider: this.name,
        arxivId: "2407.00001",
        versionId: `2407.00001v${this.version}`,
        openAccess: true,
        fullTextLocations: [
          {
            url: "https://example.org/paper.txt",
            kind: "text",
            openAccess: true,
            source: this.name,
          },
        ],
      },
    ];
  }
}

class BlockingSearchProvider extends FixtureSearchProvider {
  readonly started: Promise<void>;
  #signalStarted!: () => void;
  #release!: () => void;
  readonly released: Promise<void>;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.#signalStarted = resolve;
    });
    this.released = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release();
  }

  override async search(
    query: string,
    options: { limit: number; signal?: AbortSignal },
  ): Promise<SearchResult[]> {
    this.#signalStarted();
    await this.released;
    return super.search(query, options);
  }
}

class FixtureLlmProvider implements LlmProvider {
  readonly name = "fixture-llm";
  requests: LlmRequest[] = [];

  async complete(request: LlmRequest) {
    this.requests.push(request);
    return {
      text: JSON.stringify({
        relevance: 0.95,
        confidence: 0.9,
        difficultyEstimate: 7,
        reasons: ["abstract aligns with the explicit robotics focus"],
      }),
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

function unknownDimension(): DimensionAssessment {
  return {
    state: "unknown",
    confidence: 0,
    rationale: "Not supplied.",
    evidence: [],
  };
}

function fastReview(paperId: string): PaperReview {
  return {
    version: 1,
    id: "review-fast",
    paperId,
    sourceId: "source-metadata",
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
    model: "fixture",
    promptVersion: "fast-v1",
    createdAt: new Date().toISOString(),
  };
}

test("tracking requires explicit network approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-track-approval-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    await reader.addSubscription({
      id: "subscription-1",
      name: "Robotics",
      kind: "query",
      query: "robotics",
    });
    const provider = new FixtureSearchProvider();
    await assert.rejects(
      () => reader.track({ providers: [provider] }),
      /explicit network approval/,
    );
    await assert.rejects(
      () =>
        reader.track({
          providers: [provider],
          approveNetwork: "false" as unknown as true,
        }),
      /explicit network approval/,
    );
    assert.equal(provider.calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tracking merges duplicate subscriptions and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-track-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    const profile = await reader.getProfile();
    profile.explicit.topics.push({ term: "embodied robotics", weight: 1 });
    await reader.saveProfile(profile);
    await reader.addSubscription({
      id: "subscription-1",
      name: "World models",
      kind: "query",
      query: "world representation",
      tags: ["robotics"],
    });
    await reader.addSubscription({
      id: "subscription-2",
      name: "Predictive control",
      kind: "query",
      query: "predictive control",
      tags: ["embodied"],
    });
    const provider = new FixtureSearchProvider();
    const now = new Date("2026-07-16T12:00:00Z");
    const first = await reader.track({
      approveNetwork: true,
      providers: [provider],
      now,
    });
    assert.equal(first.run.candidates, 1);
    assert.equal(first.run.created, 1);
    assert.equal(first.papers.length, 1);
    assert.equal(first.papers[0]?.discovery.length, 2);
    assert.equal((await reader.listPapers()).length, 1);
    assert.equal((await reader.listQueue()).length, 1);
    assert.equal((await reader.runs()).length, 1);
    assert.ok((await reader.history()).length >= 2);
    assert.match(
      await readFile(first.run.reportPath!, "utf8"),
      /World Representation for Embodied Robotics/,
    );

    const second = await reader.track({
      approveNetwork: true,
      providers: [provider],
      now,
    });
    assert.equal(second.run.created, 0);
    assert.equal(second.run.updated, 1);
    assert.equal((await reader.listPapers()).length, 1);
    assert.equal((await reader.runs()).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional LLM triage is bounded and records actual usage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-track-llm-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    await reader.addSubscription({
      id: "subscription-1",
      name: "Robotics",
      kind: "query",
      query: "robotics",
    });

    test("tracking does not coerce non-boolean LLM approval", async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "reader-track-llm-guard-"),
      );
      const priorApiKey = process.env.ANTHROPIC_API_KEY;
      const priorAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      try {
        const reader = new ResearchReader({ root });
        await reader.init();
        await reader.addSubscription({
          id: "subscription-1",
          name: "Robotics",
          kind: "query",
          query: "robotics",
        });
        const result = await reader.track({
          approveNetwork: true,
          approveLlm: "false" as unknown as true,
          providers: [new FixtureSearchProvider()],
          now: new Date("2026-07-16T12:00:00Z"),
        });
        assert.equal(result.run.usage, undefined);
        assert.equal(result.papers[0]?.triage?.difficultyEstimate, undefined);
      } finally {
        if (priorApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = priorApiKey;
        if (priorAuthToken === undefined)
          delete process.env.ANTHROPIC_AUTH_TOKEN;
        else process.env.ANTHROPIC_AUTH_TOKEN = priorAuthToken;
        await rm(root, { recursive: true, force: true });
      }
    });

    test("tracking transactions preserve concurrent reading-state changes", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "reader-track-race-"));
      try {
        const reader = new ResearchReader({ root });
        await reader.init();
        await reader.addSubscription({
          id: "subscription-1",
          name: "Robotics",
          kind: "query",
          query: "robotics",
        });
        const now = new Date("2026-07-16T12:00:00Z");
        const initial = await reader.track({
          approveNetwork: true,
          providers: [new FixtureSearchProvider()],
          now,
        });
        const paperId = initial.papers[0]!.id;
        const blocking = new BlockingSearchProvider();
        const tracking = reader.track({
          approveNetwork: true,
          providers: [blocking],
          now,
        });
        await blocking.started;
        await reader.markPaper(paperId, "reading");
        blocking.release();
        await tracking;
        assert.equal(
          (await reader.getPaper(paperId))?.reading.status,
          "reading",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    const provider = new FixtureSearchProvider();
    const llm = new FixtureLlmProvider();
    const result = await reader.track({
      approveNetwork: true,
      providers: [provider],
      llmProvider: llm,
      maxLlmTokens: 10_000,
      now: new Date("2026-07-16T12:00:00Z"),
    });
    assert.equal(llm.requests[0]?.purpose, "screening");
    assert.deepEqual(result.run.usage, { inputTokens: 10, outputTokens: 5 });
    assert.equal(result.papers[0]?.triage?.difficultyEstimate, 7);
    assert.ok(
      result.papers[0]?.triage?.reasons.includes(
        "abstract aligns with the explicit robotics focus",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new arXiv versions mark existing reviews stale", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-track-version-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    await reader.addSubscription({
      id: "subscription-1",
      name: "Robotics",
      kind: "query",
      query: "robotics",
    });

    test("Reader acquisition preserves explicit approval and updates the Passport", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "reader-acquire-"));
      try {
        const reader = new ResearchReader({ root });
        await reader.init();
        await reader.addSubscription({
          id: "subscription-1",
          name: "Robotics",
          kind: "query",
          query: "robotics",
        });
        const tracked = await reader.track({
          approveNetwork: true,
          providers: [new FixtureSearchProvider()],
          now: new Date("2026-07-16T12:00:00Z"),
        });
        const paperId = tracked.papers[0]!.id;
        await assert.rejects(
          () => reader.acquirePaper(paperId),
          /explicit network approval/,
        );
        assert.equal(
          (await reader.getPaper(paperId))?.acquisition.status,
          "failed",
        );
        const acquisition = await reader.acquirePaper(paperId, {
          approveNetwork: true,
          fetch: async () =>
            new Response(
              "# Introduction\n\nWorld representations support robot control.",
              {
                status: 200,
                headers: { "content-type": "text/plain" },
              },
            ),
        });
        const paper = await reader.getPaper(paperId);
        assert.equal(paper?.acquisition.status, "available");
        assert.equal(
          paper?.acquisition.fullTextSourceId,
          acquisition.imported.artifact.id,
        );
        assert.ok(paper?.sourceIds.includes(acquisition.imported.artifact.id));
        await assert.rejects(
          () => reader.acquirePaper(paperId),
          /explicit network approval/,
        );
        const preserved = await reader.getPaper(paperId);
        assert.equal(preserved?.acquisition.status, "available");
        assert.equal(
          preserved?.acquisition.fullTextSourceId,
          acquisition.imported.artifact.id,
        );
        assert.match(
          preserved?.acquisition.lastAttemptError ?? "",
          /explicit network approval/,
        );
        await reader.saveReview(fastReview(paperId));
        const replacement = await reader.acquirePaper(paperId, {
          approveNetwork: true,
          fetch: async () =>
            new Response(
              "# Introduction\n\nA newer full-text source replaces the prior one.",
              {
                status: 200,
                headers: { "content-type": "text/plain" },
              },
            ),
        });
        const replaced = await reader.getPaper(paperId);
        assert.equal(
          replaced?.acquisition.fullTextSourceId,
          replacement.imported.artifact.id,
        );
        assert.equal(replaced?.lifecycle.reviewStale, true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    const provider = new FixtureSearchProvider();
    const first = await reader.track({
      approveNetwork: true,
      providers: [provider],
      now: new Date("2026-07-16T12:00:00Z"),
    });
    const paperId = first.papers[0]!.id;
    await reader.saveReview(fastReview(paperId));
    provider.version = 2;
    await reader.track({
      approveNetwork: true,
      providers: [provider],
      now: new Date("2026-07-16T13:00:00Z"),
    });
    const updated = await reader.getPaper(paperId);
    assert.equal(updated?.lifecycle.latestVersionId, "2407.00001v2");
    assert.equal(updated?.lifecycle.reviewStale, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
