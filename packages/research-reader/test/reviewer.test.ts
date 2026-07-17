import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getSourceArtifact,
  ingestContent,
  type LlmProvider,
  type LlmRequest,
  type SearchProvider,
  type SearchResult,
} from "@intelligent-agent-system/llm-wiki-compiler";
import {
  auditSourceCitations,
  ResearchReader,
  type PaperPassport,
} from "../src/index.js";

const INTRO_QUOTE =
  "World representations improve predictive control in embodied robots.";
const EXPERIMENT_QUOTE =
  "The controller succeeded in 90 percent of evaluation episodes.";

class ReviewProvider implements LlmProvider {
  readonly name = "fixture-reviewer";
  invalidQuote = false;
  requests: LlmRequest[] = [];

  async complete(request: LlmRequest) {
    this.requests.push(request);
    if (request.purpose === "relationship-analysis") {
      return {
        text: JSON.stringify({
          challenges: [
            {
              text: "The evaluation may be too narrow.",
              severity: "medium",
              evidenceQuotes: [EXPERIMENT_QUOTE],
            },
          ],
        }),
        usage: { inputTokens: 20, outputTokens: 10 },
      };
    }

    if (request.prompt.includes("Do not score importance")) {
      return {
        text: JSON.stringify({
          paperType: "empirical",
          personalRelevance: 0.9,
          recommendation: "deep-read",
          estimatedReadMinutes: 30,
          strengths: ["Relevant abstract"],
          weaknesses: ["Full text not reviewed"],
          prerequisites: ["predictive control"],
          readingRoute: ["Acquire full text"],
        }),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }
    const unknown = {
      state: "unknown",
      confidence: 0,
      rationale: "No grounded assessment was produced.",
      evidenceQuotes: [],
    };
    return {
      text: JSON.stringify({
        paperType: "empirical",
        dimensions: {
          importance: {
            state: "assessed",
            score: 8,
            confidence: 0.9,
            rationale: "The work addresses predictive control.",
            evidenceQuotes: [
              this.invalidQuote ? "Invented source sentence." : INTRO_QUOTE,
            ],
          },
          novelty: unknown,
          methodology: {
            state: "assessed",
            score: 7,
            confidence: 0.8,
            rationale: "The method uses a world representation.",
            evidenceQuotes: [INTRO_QUOTE],
          },
          experiments: {
            state: "assessed",
            score: 6,
            confidence: 0.8,
            rationale: "The source reports an evaluation outcome.",
            evidenceQuotes: [EXPERIMENT_QUOTE],
          },
          reproducibility: unknown,
          writing: unknown,
          theory: unknown,
        },
        personalRelevance: 0.95,
        recommendation: "priority",
        estimatedReadMinutes: 45,
        strengths: ["Grounded motivation"],
        weaknesses: ["Narrow evaluation"],
        criticalIssues: [],
        prerequisites: ["robot control"],
        readingRoute: ["Introduction", "Experiments"],
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }
}

class CitationProvider implements SearchProvider {
  constructor(
    readonly name: string,
    readonly match: boolean,
  ) {}

  async search(): Promise<SearchResult[]> {
    return this.match
      ? [
          {
            id: "10.1000/reader",
            title: "Verified Reference",
            url: "https://doi.org/10.1000/reader",
            provider: this.name,
            doi: "10.1000/reader",
          },
        ]
      : [];
  }
}

function passport(sourceId?: string, id = "paper-review"): PaperPassport {
  const now = new Date().toISOString();
  return {
    version: 1,
    id,
    canonicalKey: `arxiv:${id}`,
    sourceIds: sourceId ? [sourceId] : [],
    metadata: {
      id,
      title: "World Representation Review",
      url: "https://arxiv.org/abs/2407.00001",
      provider: "arxiv",
      arxivId: "2407.00001",
      year: 2026,
      published: "2026-07-15",
    },
    candidate: {
      id,
      title: "World Representation Review",
      url: "https://arxiv.org/abs/2407.00001",
      provider: "arxiv",
      arxivId: "2407.00001",
      abstract: "A world representation for predictive robot control.",
      year: 2026,
      published: "2026-07-15",
    },
    discovery: [],
    acquisition: sourceId
      ? { status: "available", fullTextSourceId: sourceId }
      : { status: "metadata-only" },
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
      latestVersionId: "2407.00001v1",
      reviewStale: false,
      retracted: false,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function fastReview(paperId: string): PaperReview {
  const unknown = (): DimensionAssessment => ({
    state: "unknown",
    confidence: 0,
    rationale: "Full text was not supplied.",
    evidence: [],
  });
  return {
    version: 1,
    id: "review-fast-fixture",
    paperId,
    sourceId: "metadata-only",
    level: "fast",
    paperType: "other",
    coverage: {
      fullText: false,
      sections: ["abstract"],
      pages: [],
      coverageScore: 0.05,
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
    evidenceConfidence: 0.05,
    personalRelevance: 0.5,
    recommendation: "skim",
    strengths: [],
    weaknesses: [],
    criticalIssues: [],
    prerequisites: [],
    readingRoute: [],
    adversarialChallenges: [],
    unresolvedChallenges: [],
    model: "fixture",
    promptVersion: "fixture-fast",
    createdAt: new Date().toISOString(),
  };
}

async function fullTextSource(root: string): Promise<string> {
  const ingested = await ingestContent(
    `# Introduction

${INTRO_QUOTE}

# Experiments

${EXPERIMENT_QUOTE}

# References

The discussion cites (Smith, 2027).
The implementation follows DOI 10.1000/reader.
`,
    "review-source.md",
    {
      root,
      title: "World Representation Review",
      literature: {
        id: "2407.00001",
        title: "World Representation Review",
        url: "https://arxiv.org/abs/2407.00001",
        provider: "arxiv",
        arxivId: "2407.00001",
        year: 2026,
        published: "2026-07-15",
      },
    },
  );
  return ingested.artifact.id;
}

test("fast review keeps all scientific dimensions unknown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-fast-review-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    await reader.savePaper(passport());
    const provider = new ReviewProvider();
    const review = await reader.reviewPaper("paper-review", {
      level: "fast",
      llmProvider: provider,
      maxLlmTokens: 10_000,
    });
    assert.equal(review.scientificQuality, undefined);
    assert.ok(
      Object.values(review.dimensions).every(
        (dimension) => dimension?.state === "unknown",
      ),
    );
    assert.equal(review.personalRelevance, 0.9);
    assert.equal(provider.requests.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standard review requires acquired full text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-review-full-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    await reader.savePaper(passport());
    await assert.rejects(
      () =>
        reader.reviewPaper("paper-review", {
          level: "standard",
          llmProvider: new ReviewProvider(),
        }),
      /requires acquired full text/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("paper Review lists are ordered by createdAt rather than random IDs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-review-order-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    await reader.savePaper(passport());
    const older = fastReview("paper-review");
    older.id = "review-z";
    older.createdAt = "2026-07-15T00:00:00.000Z";
    const newer = fastReview("paper-review");
    newer.id = "review-a";
    newer.createdAt = "2026-07-16T00:00:00.000Z";
    await reader.saveReview(older);
    await reader.saveReview(newer);
    assert.deepEqual(
      (await reader.listReviews("paper-review")).map((item) => item.id),
      ["review-a", "review-z"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standard review validates evidence and runs adversarial integrity passes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-standard-review-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    const sourceId = await fullTextSource(root);
    await reader.savePaper(passport(sourceId));
    const provider = new ReviewProvider();
    const review = await reader.reviewPaper("paper-review", {
      level: "standard",
      llmProvider: provider,
      maxLlmTokens: 50_000,
      adversarial: true,
    });
    assert.equal(review.dimensions.importance.state, "assessed");
    assert.equal(review.dimensions.importance.evidence[0]?.quote, INTRO_QUOTE);
    assert.ok(review.scientificQuality !== undefined);
    assert.equal(review.adversarialChallenges.length, 1);
    assert.equal(
      review.adversarialChallenges[0]?.evidence[0]?.quote,
      EXPERIMENT_QUOTE,
    );
    assert.ok(
      review.integrityIssues?.some(
        (issue) =>
          issue.type === "temporal" && issue.severity === "high-warning",
      ),
    );
    assert.equal((await reader.listReviews("paper-review")).length, 1);
    assert.equal((await reader.getPaper("paper-review"))?.reviewIds.length, 1);
    const tampered = structuredClone(review);
    tampered.id = "review-tampered";
    tampered.dimensions.importance.evidence[0]!.start += 1;
    await assert.rejects(() => reader.saveReview(tampered), /start offset/);

    const unrelated = await ingestContent(
      "Unrelated source.",
      "unrelated.txt",
      { root },
    );
    const wrongSource = fastReview("paper-review");
    wrongSource.id = "review-wrong-source";
    wrongSource.level = "standard";
    wrongSource.sourceId = unrelated.artifact.id;
    wrongSource.sourceVersion = "2407.00001v1";
    wrongSource.coverage = {
      fullText: true,
      sections: ["full-text"],
      pages: [],
      coverageScore: 1,
    };
    await assert.rejects(
      () => reader.saveReview(wrongSource),
      /not the current full-text source/,
    );
    const wrongVersion = structuredClone(wrongSource);
    wrongVersion.id = "review-wrong-version";
    wrongVersion.sourceId = sourceId;
    wrongVersion.sourceVersion = "2407.00001v0";
    await assert.rejects(
      () => reader.saveReview(wrongVersion),
      /version does not match/,
    );

    const stalePaper = await reader.getPaper("paper-review");
    stalePaper!.lifecycle.reviewStale = true;
    await reader.savePaper(stalePaper!);
    const fast = fastReview("paper-review");
    fast.id = "review-fast-stale";
    await reader.saveReview(fast);
    assert.equal(
      (await reader.getPaper("paper-review"))?.lifecycle.reviewStale,
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invented Review evidence is rejected without persisting a Review", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-review-evidence-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    const sourceId = await fullTextSource(root);
    await reader.savePaper(passport(sourceId));
    const provider = new ReviewProvider();
    provider.invalidQuote = true;
    await assert.rejects(
      () =>
        reader.reviewPaper("paper-review", {
          level: "standard",
          llmProvider: provider,
          adversarial: false,
        }),
      /Evidence quote is not present/,
    );
    assert.equal((await reader.listReviews("paper-review")).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("citation audit verifies exact identifiers and stays conservative on absence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-citation-audit-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    const sourceId = await fullTextSource(root);
    const source = await getSourceArtifact(sourceId, { root });
    assert.ok(source);
    await assert.rejects(
      () =>
        auditSourceCitations(source, {
          root,
          providers: [new CitationProvider("one", true)],
        }),
      /explicit network approval/,
    );
    const verified = await auditSourceCitations(source, {
      root,
      approveNetwork: true,
      providers: [new CitationProvider("one", true)],
    });
    assert.equal(verified[0]?.status, "verified");
    const suspicious = await auditSourceCitations(source, {
      root,
      approveNetwork: true,
      providers: [
        new CitationProvider("one", false),
        new CitationProvider("two", false),
      ],
    });
    assert.equal(suspicious[0]?.status, "suspicious");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
