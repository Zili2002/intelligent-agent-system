import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireSearchResult,
  extractSourceSections,
  findEvidenceAnchor,
  getSourceArtifact,
  ingestContent,
  initWiki,
  listSourceArtifacts,
  loadConfig,
  querySource,
  requireLlm,
  validateEvidenceAnchor,
  type SearchResult,
} from "../src/index.js";

test("Reader Source APIs load artifacts and validate exact evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-reader-source-"));
  try {
    await initWiki(root);
    const ingested = await ingestContent(
      `# Introduction

World representations support predictive control in embodied robots.

# Experiments

The controller completed 90 percent of evaluation episodes.
`,
      "reader-source.md",
      { root, title: "Reader Source" },
    );
    const stored = await getSourceArtifact(ingested.artifact.id, { root });
    assert.equal(stored?.title, "Reader Source");
    assert.equal((await listSourceArtifacts({ root })).length, 1);
    const source = {
      ...stored!,
      pageLocators: [{ start: 0, end: stored!.content.length, page: 1 }],
    };
    const anchor = findEvidenceAnchor(
      source,
      "World representations support predictive control in embodied robots.",
    );
    assert.equal(anchor.page, 1);
    assert.equal(anchor.section, "Introduction");
    assert.deepEqual(validateEvidenceAnchor(source, anchor), anchor);
    assert.throws(
      () =>
        validateEvidenceAnchor(source, {
          ...anchor,
          start: anchor.start + 1,
        }),
      /start offset/,
    );
    const sections = extractSourceSections(source);
    assert.deepEqual(
      sections.map((section) => section.id),
      ["introduction", "experiments"],
    );
    const matches = querySource(source, "predictive control", 3);
    assert.equal(matches[0]?.anchor.sourceId, source.id);
    assert.match(matches[0]?.excerpt ?? "", /predictive control/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selected-result acquisition requires approval and preserves provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-reader-acquire-"));
  try {
    await initWiki(root);
    const result: SearchResult = {
      id: "reader-result",
      title: "Open Reader Result",
      url: "https://example.org/record",
      abstract: "An open research result.",
      provider: "fixture",
      openAccess: true,
      fullTextLocations: [
        {
          url: "https://example.org/paper.txt",
          kind: "text",
          openAccess: true,
          source: "fixture",
        },
      ],
    };
    await assert.rejects(
      () => acquireSearchResult(result, { root }),
      /explicit network approval/,
    );
    await assert.rejects(
      () =>
        acquireSearchResult(result, {
          root,
          approveNetwork: "false" as unknown as true,
        }),
      /explicit network approval/,
    );
    await assert.rejects(
      () =>
        acquireSearchResult(result, {
          root,
          approveNetwork: true,
          maxFileBytes: Number.NaN,
        }),
      /positive finite integer/,
    );
    const acquisition = await acquireSearchResult(result, {
      root,
      approveNetwork: true,
      fetch: async () =>
        new Response("Open full text for evidence review.", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    });

    test("Source APIs reject tampered content and filename identity mismatches", async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "wiki-source-integrity-"),
      );
      try {
        await initWiki(root);
        const ingested = await ingestContent(
          "Integrity evidence.",
          "source.txt",
          {
            root,
          },
        );
        const sourcePath = path.join(
          root,
          "sources",
          `${ingested.artifact.id}.json`,
        );
        const original = JSON.parse(await readFile(sourcePath, "utf8")) as {
          content: string;
        };
        await writeFile(
          sourcePath,
          `${JSON.stringify({ ...original, content: "Tampered evidence." })}\n`,
          "utf8",
        );
        await assert.rejects(
          () => getSourceArtifact(ingested.artifact.id, { root }),
          /content hash mismatch/,
        );

        await writeFile(
          sourcePath,
          `${JSON.stringify(ingested.artifact)}\n`,
          "utf8",
        );
        await writeFile(
          path.join(root, "sources", `${"0".repeat(64)}.json`),
          `${JSON.stringify(ingested.artifact)}\n`,
          "utf8",
        );
        await assert.rejects(
          () => listSourceArtifacts({ root }),
          /filename mismatch/,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("LLM approval requires the boolean true at runtime", async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "wiki-reader-approval-"),
      );
      try {
        await initWiki(root);
        const config = await loadConfig(root);
        assert.throws(
          () =>
            requireLlm(config, {
              root,
              approveLlm: "false" as unknown as true,
            }),
          /explicit approval/,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("duplicate evidence quotes require offsets and honor later occurrences", () => {
      const first = "Repeated evidence.";
      const content = `# First\n\n${first}\n\n# Second\n\n${first}`;
      const secondStart = content.lastIndexOf(first);
      const source = {
        version: 1 as const,
        id: "a".repeat(64),
        hash: "a".repeat(64),
        title: "Duplicate Evidence",
        mediaType: "text/markdown",
        content,
        pageLocators: [
          { start: 0, end: secondStart, page: 1 },
          { start: secondStart, end: content.length, page: 2 },
        ],
        provenance: { kind: "file" as const, input: "duplicate.md" },
        provenanceHistory: [{ kind: "file" as const, input: "duplicate.md" }],
        ingestedAt: new Date().toISOString(),
      };
      assert.throws(() => findEvidenceAnchor(source, first), /ambiguous/);
      const anchor = validateEvidenceAnchor(source, {
        sourceId: source.id,
        quote: first,
        start: secondStart,
        end: secondStart + first.length,
        page: 2,
        section: "Second",
      });
      assert.equal(anchor.start, secondStart);
      assert.equal(anchor.page, 2);
    });
    assert.equal(acquisition.imported.artifact.title, result.title);
    assert.equal(
      acquisition.imported.artifact.provenance.url,
      "https://example.org/paper.txt",
    );
    assert.equal(acquisition.imported.artifact.literature?.openAccess, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
