import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ingestContent,
  type LlmProvider,
  type LlmRequest,
} from "@intelligent-agent-system/llm-wiki-compiler";
import {
  DEFAULT_READER_CONFIG,
  ResearchReader,
  type PaperPassport,
} from "../src/index.js";

const FIRST_QUOTE =
  "World representations support predictive control for embodied robots.";
const SECOND_QUOTE =
  "Reactive policies select actions directly from current observations.";

class ReadingProvider implements LlmProvider {
  readonly name = "reading-fixture";
  invalidCitation = false;
  requests: LlmRequest[] = [];

  async complete(request: LlmRequest) {
    this.requests.push(request);
    if (request.purpose === "query") {
      return {
        text: JSON.stringify({
          answer: "The paper uses a predictive world representation.",
          citations: [
            this.invalidCitation ? "Invented answer evidence." : FIRST_QUOTE,
          ],
        }),
        usage: { inputTokens: 20, outputTokens: 10 },
      };
    }
    if (request.purpose === "synthesis") {
      return {
        text: JSON.stringify({
          summary: "The papers differ in whether they predict future state.",
          differences: [
            {
              topic: "Control signal",
              analysis: "One predicts latent state; the other reacts directly.",
              evidence: [
                { paperId: "paper-one", quote: FIRST_QUOTE },
                { paperId: "paper-two", quote: SECOND_QUOTE },
              ],
            },
          ],
        }),
        usage: { inputTokens: 40, outputTokens: 20 },
      };
    }
    throw new Error(`Unexpected purpose: ${request.purpose}`);
  }
}

function passport(id: string, sourceId: string, title: string): PaperPassport {
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
    acquisition: { status: "available", fullTextSourceId: sourceId },
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

async function createPaperSources(root: string) {
  const first = await ingestContent(
    `# Introduction

${FIRST_QUOTE}

# Limitations

The evaluation covers one simulated environment.
`,
    "paper-one.md",
    { root, title: "Predictive World Representation" },
  );
  const second = await ingestContent(
    `# Introduction

${SECOND_QUOTE}

# Limitations

The policy does not model future state.
`,
    "paper-two.md",
    { root, title: "Reactive Policy" },
  );
  return { first: first.artifact.id, second: second.artifact.id };
}

test("Reading Sessions enforce progressive checkpoints and preserve notes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-session-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    const sources = await createPaperSources(root);
    await reader.savePaper(
      passport("paper-one", sources.first, "Predictive World Representation"),
    );
    const session = await reader.startReading(
      "paper-one",
      "guided-read",
      "exploratory",
    );
    await assert.rejects(
      () => reader.completeReading(session.id),
      /requires confirmed Level 1/,
    );
    await reader.checkpointReading(session.id, {
      level: 1,
      userConfirmed: true,
      percent: 30,
    });
    await reader.checkpointReading(session.id, {
      level: 2,
      userConfirmed: true,
      percent: 80,
      understanding: 4,
      unresolvedQuestions: ["How does the latent state generalize?"],
    });
    await reader.addNote("paper-one", "First user note.");
    await reader.addNote("paper-one", "Second user note.");
    const note = await reader.readNote("paper-one");
    assert.match(note ?? "", /First user note/);
    assert.match(note ?? "", /Second user note/);
    const completed = await reader.completeReading(session.id);
    assert.equal(completed.status, "completed");
    const paper = await reader.getPaper("paper-one");
    assert.equal(paper?.reading.status, "read");
    assert.equal(paper?.reading.understandingScore, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("paper-scoped questions validate citations and persist to a session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-question-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    const sources = await createPaperSources(root);
    await reader.savePaper(
      passport("paper-one", sources.first, "Predictive World Representation"),
    );
    const session = await reader.startReading(
      "paper-one",
      "guided-read",
      "goal-oriented",
    );
    const provider = new ReadingProvider();
    const answer = await reader.askPaper(
      "paper-one",
      "How does the paper support predictive control?",
      { llmProvider: provider, maxLlmTokens: 10_000 },
      session.id,
    );
    assert.equal(answer.citations[0]?.quote, FIRST_QUOTE);
    assert.equal((await reader.getSession(session.id))?.questions.length, 1);
    provider.invalidCitation = true;
    await assert.rejects(
      () =>
        reader.askPaper(
          "paper-one",
          "How does the paper support predictive control?",
          { llmProvider: provider, maxLlmTokens: 10_000 },
          session.id,
        ),
      /outside supplied excerpts/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("paper comparison validates evidence from every referenced paper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-compare-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    const sources = await createPaperSources(root);
    await reader.savePaper(
      passport("paper-one", sources.first, "Predictive World Representation"),
    );
    await reader.savePaper(
      passport("paper-two", sources.second, "Reactive Policy"),
    );
    const comparison = await reader.comparePapers(["paper-one", "paper-two"], {
      llmProvider: new ReadingProvider(),
      maxLlmTokens: 10_000,
    });
    assert.equal(comparison.differences[0]?.evidence.length, 2);
    assert.match(
      await readFile(comparison.markdownPath, "utf8"),
      /Control signal/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit no-recompile extraction links existing Claims and preserves user content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-extract-"));
  try {
    const reader = new ResearchReader({ root });
    await reader.init();
    const sources = await createPaperSources(root);
    await reader.savePaper(
      passport("paper-one", sources.first, "Predictive World Representation"),
    );
    await writeFile(
      path.join(root, "meta", "claims.json"),
      `${JSON.stringify(
        {
          version: 1,
          claims: [
            {
              id: "claim-reader-1",
              sourceId: sources.first,
              text: "World representations support predictive control.",
              quote: FIRST_QUOTE,
            },
          ],
          sources: [
            {
              id: sources.first,
              title: "Predictive World Representation",
              path: "wiki/sources/predictive.md",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const first = await reader.extractPaper("paper-one", {
      recompile: false,
    });

    test("annotations validate selected quotes and mark version drift for remapping", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "reader-annotation-"));
      try {
        const reader = new ResearchReader({ root });
        await reader.init();
        const sources = await createPaperSources(root);
        const paper = passport(
          "paper-one",
          sources.first,
          "Predictive World Representation",
        );
        paper.lifecycle.latestVersionId = "paper-one-v1";
        await reader.savePaper(paper);
        const annotation = await reader.addAnnotation("paper-one", {
          selectedQuote: FIRST_QUOTE,
          drawingDataUrl: "data:image/png;base64,AA==",
          voiceTranscript: "Important mechanism.",
          note: "Important mechanism.",
        });

        test("extraction uses Compiler metaDir when Reader metaPath is customized", async () => {
          const root = await mkdtemp(
            path.join(os.tmpdir(), "reader-custom-meta-"),
          );
          try {
            await writeFile(
              path.join(root, ".research-reader-config.json"),
              `${JSON.stringify({
                ...DEFAULT_READER_CONFIG,
                metaPath: "custom-reader-state",
              })}\n`,
              "utf8",
            );
            const reader = new ResearchReader({ root });
            await reader.init();
            const sources = await createPaperSources(root);
            await reader.savePaper(
              passport(
                "paper-one",
                sources.first,
                "Predictive World Representation",
              ),
            );
            await writeFile(
              path.join(root, "meta", "claims.json"),
              `${JSON.stringify({
                version: 1,
                claims: [
                  {
                    id: "claim-custom-meta",
                    sourceId: sources.first,
                    text: "Custom meta Claim.",
                    quote: FIRST_QUOTE,
                  },
                ],
              })}\n`,
              "utf8",
            );
            const extracted = await reader.extractPaper("paper-one", {
              recompile: false,
            });
            assert.deepEqual(extracted.claimIds, ["claim-custom-meta"]);
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        });
        assert.equal(annotation.status, "active");
        assert.equal(annotation.voiceTranscript, "Important mechanism.");
        await assert.rejects(
          () =>
            reader.addAnnotation("paper-one", {
              selectedQuote: "Invented quote.",
              note: "Invalid.",
            }),
          /not present/,
        );
        await assert.rejects(
          () =>
            reader.addAnnotation("paper-one", {
              drawingDataUrl: "data:text/plain;base64,AA==",
              note: "Invalid drawing.",
            }),
          /bounded PNG/,
        );
        const updated = await reader.getPaper("paper-one");
        updated!.lifecycle.latestVersionId = "paper-one-v2";
        await reader.savePaper(updated!);
        assert.equal(
          (await reader.annotations("paper-one"))[0]?.status,
          "needs-remap",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    await writeFile(
      first.pagePath,
      `${await readFile(first.pagePath, "utf8")}\nUser-authored interpretation.\n`,
      "utf8",
    );
    await reader.extractPaper("paper-one", { recompile: false });
    const page = await readFile(first.pagePath, "utf8");
    assert.match(page, /claim-reader-1/);
    assert.match(page, /User-authored interpretation/);
    assert.deepEqual((await reader.getPaper("paper-one"))?.knowledge.claimIds, [
      "claim-reader-1",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
