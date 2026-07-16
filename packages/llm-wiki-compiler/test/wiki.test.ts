import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  autoCommitIfEnabled,
  adjudicateWiki,
  acquireFullText,
  chunkSource,
  cleanModel,
  compileWiki,
  corroborateWiki,
  CrossrefProvider,
  ArxivProvider,
  buildQualityArtifacts,
  scoreSource,
  getStatus,
  OpenAlexProvider,
  ingest,
  ingestContent,
  initWiki,
  learnWiki,
  lintWiki,
  loadConfig,
  mergeSearchResults,
  resetArxivThrottleForTests,
  searchProviderRegistry,
  validateConfig,
  loadRawManifest,
  queryWiki,
  requestJson,
  reflectWiki,
  restoreRaw,
  searchWiki,
  slugify,
  type SearchProvider,
  type SearchResult,
  type LlmProvider,
  type SourceArtifact,
  LlmUsageTracker,
  WikiLlmResponseError,
} from "../src/index.js";

const workRoot = path.resolve("test", ".work");
let sequence = 0;
const fakeLlm: LlmProvider = {
  name: "fake",
  async complete(request) {
    if (request.purpose === "source-analysis") {
      const content = request.prompt.slice(request.prompt.indexOf("\n\n") + 2);
      const quote = `${content.split(".")[0]?.trim()}.`;
      return {
        text: JSON.stringify({
          relevant: true,
          exclusionReason: "in scope",
          summary: quote,
          concepts:
            quote.length > 1
              ? [
                  {
                    id: "evidence",
                    title: "Evidence",
                    definition:
                      "Evidence represented by the quoted source claim.",
                    claimIds: ["c1"],
                  },
                ]
              : [],
          claims: quote.length > 1 ? [{ id: "c1", text: quote, quote }] : [],
        }),
      };
    }
    if (request.purpose === "synthesis") {
      const entries = JSON.parse(
        request.prompt.slice(request.prompt.lastIndexOf("\n") + 1),
      ) as Array<{
        sourceId: string;
        claims: Array<{ id: string; text: string; quote: string }>;
      }>;
      const first = entries[0];
      const firstClaim = first?.claims[0];
      const claimId = firstClaim?.id ?? "";
      return {
        text: JSON.stringify(
          first && firstClaim
            ? {
                concepts: [
                  {
                    id: "evidence",
                    title: "Evidence",
                    definition: "Evidence supported by the selected claim.",
                    claimIds: [claimId],
                  },
                ],
                claims: [
                  {
                    id: claimId,
                    sourceId: first.sourceId,
                    quote: firstClaim.quote,
                    text: firstClaim.text,
                    conceptIds: ["evidence"],
                  },
                ],
                contradictions: [],
                gaps: [
                  {
                    priority: 1,
                    description: "Need more evidence",
                    searchQuery: "more evidence",
                  },
                ],
              }
            : { concepts: [], claims: [], contradictions: [], gaps: [] },
        ),
      };
    }
    if (request.purpose === "query")
      return {
        text: JSON.stringify({
          answer: "Evidence-backed answer.",
          citations: request.prompt.match(/"id":"(claim-[a-f0-9]+)"/)?.[1]
            ? [request.prompt.match(/"id":"(claim-[a-f0-9]+)"/)![1]]
            : [],
        }),
      };
    if (request.purpose === "reflection") {
      const sourceId = request.prompt.match(/"sources":\[\{"id":"(s\d+)"/)?.[1];
      const claimId = request.prompt.match(/"claims":\[\{"id":"(c\d+)"/)?.[1];
      return {
        text: JSON.stringify({
          observations:
            sourceId && claimId
              ? [
                  {
                    text: "Coverage reviewed.",
                    sourceIds: [sourceId],
                    claimIds: [claimId],
                  },
                ]
              : [],
          gaps: [],
        }),
      };
    }
    if (request.purpose === "corroboration-plan") {
      const targets = JSON.parse(
        request.prompt.slice(request.prompt.lastIndexOf("\n") + 1),
      ) as Array<{ claimId: string }>;
      return {
        text: JSON.stringify({
          targets: targets.map((target) => ({
            claimId: target.claimId,
            supportQuery: `${target.claimId} independent support`,
            challengeQuery: `${target.claimId} failure conditions`,
          })),
        }),
      };
    }
    if (request.purpose === "contradiction-adjudication") {
      const entries = JSON.parse(
        request.prompt.slice(request.prompt.lastIndexOf("\n") + 1),
      ) as Array<{ from: string; to: string; claims: Array<{ id: string }> }>;
      const batchClaimIds = [
        ...new Set(
          entries.flatMap((entry) => entry.claims.map((claim) => claim.id)),
        ),
      ];
      return {
        text: JSON.stringify({
          adjudications: entries.map((entry) => ({
            from: entry.from,
            to: entry.to,
            resolution: "context-dependent",
            rationale: "The supplied claims use different operating contexts.",
            evidenceClaimIds: batchClaimIds,
            evidenceNeeds: "A controlled comparison under matched scope.",
          })),
        }),
      };
    }
    return {
      text: JSON.stringify({
        relevant: true,
        duplicate: false,
        reason: "relevant",
      }),
    };
  },
};

test("quality scoring is deterministic, bounded, and evidence-aware", () => {
  const source = (
    id: string,
    content: string,
    overrides: Partial<SourceArtifact> = {},
  ): SourceArtifact => ({
    version: 1,
    id,
    hash: id,
    title: id,
    mediaType: "text/plain",
    content,
    provenance: { kind: "search", input: id, provider: "openalex" },
    provenanceHistory: [{ kind: "search", input: id, provider: "openalex" }],
    ingestedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
  const regular = source("a".repeat(64), "full text ".repeat(200), {
    literature: {
      id: "a",
      title: "a",
      url: "https://example.test/a",
      provider: "openalex",
      providers: ["openalex", "crossref"],
      doi: "10.1/a",
      authors: ["A"],
      year: 2026,
      venue: "Journal",
      citationCount: 1_000_000,
      openAccess: true,
      license: "CC-BY",
    },
  });
  const synthetic = source("b".repeat(64), "Synthetic simulation experiment.", {
    provenance: { kind: "experiment", input: "b" },
    provenanceHistory: [{ kind: "experiment", input: "b" }],
  });
  const discussesSyntheticData = source(
    "c".repeat(64),
    "This literature source discusses synthetic data without being synthetic evidence.",
  );
  const claims = [
    { id: "claim-a", sourceId: regular.id, statement: "A", quote: "A" },
    { id: "claim-b", sourceId: synthetic.id, statement: "B", quote: "B" },
  ];
  const quality = buildQualityArtifacts(
    [regular, synthetic],
    claims,
    [
      {
        from: "claim-a",
        to: "claim-b",
        type: "supports",
        explanation: "support",
      },
      {
        from: "claim-a",
        to: "claim-b",
        type: "contradicts",
        explanation: "conflict",
      },
    ],
    new Date("2026-07-15T00:00:00.000Z"),
  );
  const regularScore = quality.sourceScores.find(
    (item) => item.sourceId === regular.id,
  )!;
  const syntheticScore = quality.sourceScores.find(
    (item) => item.sourceId === synthetic.id,
  )!;
  assert.equal(regularScore.components.citations, 12);
  assert.ok(regularScore.score > syntheticScore.score);
  assert.ok(syntheticScore.score <= 40);
  assert.equal(scoreSource(discussesSyntheticData).evidenceClass, "full-text");
  const contested = quality.claimConfidence.find(
    (item) => item.claimId === "claim-a",
  )!;
  assert.equal(contested.evidenceStatus, "contested");
  assert.equal(contested.independentSupportSources, 1);
  const syntheticClaim = quality.claimConfidence.find(
    (item) => item.claimId === "claim-b",
  )!;
  assert.ok(syntheticClaim.confidence <= 45);
  const supportedSynthetic = buildQualityArtifacts(
    [regular, synthetic],
    claims,
    [
      {
        from: "claim-a",
        to: "claim-b",
        type: "supports",
        explanation: "support",
      },
    ],
    new Date("2026-07-15T00:00:00.000Z"),
  ).claimConfidence.find((item) => item.claimId === "claim-b")!;
  assert.equal(supportedSynthetic.evidenceStatus, "corroborated");
  assert.ok(supportedSynthetic.confidence <= 45);
});

async function minimalPdf(text: string): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  page.drawText(text, { x: 72, y: 720, size: 18, font });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function workspace(name: string): Promise<string> {
  const root = path.join(
    workRoot,
    `${String(++sequence).padStart(2, "0")}-${name}`,
  );
  await mkdir(root, { recursive: true });
  return root;
}

before(async () => {
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(workRoot, { recursive: true });
});

after(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

test("init creates validated configured directories", async () => {
  const root = await workspace("init");
  await initWiki(root, {
    wikiPath: "knowledge",
    sourcesPath: "processed",
    rawPath: "inputs",
  });
  const config = await loadConfig(root);
  assert.equal(config.wikiDir, path.join(root, "knowledge"));
  for (const directory of [
    "entities",
    "concepts",
    "ideas",
    "methods",
    "patterns",
    "tools",
  ]) {
    assert.equal(
      (await import("node:fs")).existsSync(
        path.join(config.wikiDir, directory),
      ),
      true,
    );
  }
  assert.equal(
    (await import("node:fs")).existsSync(path.join(root, "meta", "reflection")),
    true,
  );
  assert.equal(
    (await import("node:fs")).existsSync(path.join(root, "schema")),
    true,
  );
  assert.match(
    await readFile(path.join(root, "meta", "capability_map.md"), "utf8"),
    /Capability map/,
  );
  assert.match(
    await readFile(path.join(root, "meta", "evolution_log.md"), "utf8"),
    /Evolution log/,
  );
  assert.match(
    await readFile(path.join(root, "inputs", "manifest.json"), "utf8"),
    /"version": 1/,
  );
  assert.equal(await autoCommitIfEnabled(root), false);
  assert.equal(slugify("主动学习"), "主动学习");
});

test("legacy Wiki configs inherit Opus adaptive-thinking defaults", async () => {
  const root = await workspace("legacy-llm-config");
  await initWiki(root);
  const configPath = path.join(root, ".llmwiki-config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  delete config.llm.reflectionOutputTokens;
  delete config.llm.screeningOutputTokens;
  delete config.llm.thinking;
  await writeFile(configPath, JSON.stringify(config), "utf8");
  const loaded = await loadConfig(root);
  assert.equal(loaded.llm.reflectionOutputTokens, 6000);
  assert.equal(loaded.llm.screeningOutputTokens, 2000);
  assert.deepEqual(loaded.llm.thinking, {
    type: "adaptive",
    effort: "high",
  });
});

test("chunking is stable, section-aware, and covers normalized content", () => {
  const content =
    "# First\n\nAlpha paragraph is exact.\n\n# Second\n\nBeta paragraph is exact.\n\nGamma paragraph is exact.";
  const source = {
    id: "a".repeat(64),
    hash: "a".repeat(64),
    title: "Chunk source",
    mediaType: "text/plain",
    content,
    provenance: { kind: "file" as const, input: "chunk.txt" },
    provenanceHistory: [{ kind: "file" as const, input: "chunk.txt" }],
    ingestedAt: "2020-01-01T00:00:00.000Z",
    version: 1 as const,
  };
  const config = {
    chunkInputChars: 38,
    chunkOverlapChars: 8,
    maxChunksPerSource: 10,
  };
  const chunks = chunkSource(source, config);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunkSource(source, config), chunks);
  assert.equal(chunks[0]!.start, 0);
  assert.equal(chunks.at(-1)!.end, content.length);
  assert.ok(
    chunks.every(
      (chunk) => content.slice(chunk.start, chunk.end) === chunk.content,
    ),
  );
  assert.ok(chunks.some((chunk) => chunk.section === "Second"));
});

test("long sources compile by chunks and preflight chunk overflow before spend", async () => {
  const root = await workspace("chunked-compile");
  await initWiki(root);
  await ingestContent(
    "# One\n\nFirst exact chunk evidence.\n\n# Two\n\nSecond exact chunk evidence.\n\n# Three\n\nThird exact chunk evidence.",
    "long.txt",
    { root },
  );
  const configPath = path.join(root, ".llmwiki-config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.llm.chunkInputChars = 45;
  config.llm.chunkOverlapChars = 5;
  config.llm.maxChunksPerSource = 10;
  await writeFile(configPath, JSON.stringify(config), "utf8");
  let calls = 0;
  const counting: LlmProvider = {
    name: "chunk-counting",
    async complete(request) {
      if (request.purpose === "source-analysis") calls++;
      return fakeLlm.complete(request);
    },
  };
  const compiled = await compileWiki({ root, llmProvider: counting });
  assert.ok(compiled.concepts > 0);
  const initialCalls = calls;
  await compileWiki({ root, llmProvider: counting });
  assert.equal(calls, initialCalls);
  config.llm.maxChunksPerSource = 1;
  await writeFile(configPath, JSON.stringify(config), "utf8");
  await assert.rejects(
    () => compileWiki({ root, llmProvider: counting }),
    /maxChunksPerSource/,
  );
  assert.equal(calls, initialCalls);
});

test("changing one chunk reuses unchanged chunk analyses", async () => {
  const root = await workspace("chunk-selective-cache");
  await initWiki(root);
  const configPath = path.join(root, ".llmwiki-config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.llm.chunkInputChars = 52;
  config.llm.chunkOverlapChars = 0;
  await writeFile(configPath, JSON.stringify(config), "utf8");
  const original =
    "# Stable\n\nStable first evidence sentence.\n\n# Changed\n\nChanged evidence version one.";
  await ingestContent(original, "original.txt", { root });
  let calls = 0;
  const counting: LlmProvider = {
    name: "selective-cache",
    async complete(request) {
      if (request.purpose === "source-analysis") calls++;
      return fakeLlm.complete(request);
    },
  };
  await compileWiki({ root, llmProvider: counting });
  const initialCalls = calls;
  await ingestContent(
    original.replace("version one", "version two"),
    "changed.txt",
    { root },
  );
  await compileWiki({ root, llmProvider: counting });
  const additionalCalls = calls - initialCalls;
  assert.ok(additionalCalls > 0);
  assert.ok(additionalCalls < initialCalls);
});

test("chunk overlap deduplicates claims and emits evidence locators", async () => {
  const root = await workspace("chunk-locators");
  await initWiki(root);
  await ingestContent(
    "# Evidence\n\nRepeated exact evidence sentence.\n\nRepeated exact evidence sentence.\n\n# More\n\nRepeated exact evidence sentence.",
    "overlap.txt",
    { root },
  );
  const configPath = path.join(root, ".llmwiki-config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.llm.chunkInputChars = 55;
  config.llm.chunkOverlapChars = 30;
  await writeFile(configPath, JSON.stringify(config), "utf8");
  const result = await compileWiki({ root, llmProvider: fakeLlm });
  const graph = JSON.parse(await readFile(result.graphPath, "utf8"));
  assert.equal(graph.version, 3);
  assert.ok(
    graph.claims.every((claim: { locator?: unknown }) => claim.locator),
  );
  const page = await readFile(
    path.join(
      root,
      "wiki",
      "sources",
      (await readdir(path.join(root, "wiki", "sources")))[0]!,
    ),
    "utf8",
  );
  assert.match(page, /Evidence locators/);
});

test("chunk analysis maps unique whitespace-normalized quotes back to exact text", async () => {
  const root = await workspace("chunk-whitespace-quote");
  await initWiki(root);
  await ingestContent(
    "Exact evidence spans\nmultiple lines without changing words.",
    "wrapped.txt",
    { root },
  );
  const provider: LlmProvider = {
    name: "wrapped-quote",
    async complete(request) {
      if (request.purpose === "source-analysis") {
        return {
          text: JSON.stringify({
            relevant: true,
            exclusionReason: "",
            summary: "Wrapped evidence.",
            concepts: [
              {
                id: "wrapped",
                title: "Wrapped evidence",
                definition: "Evidence split only by source whitespace.",
                claimIds: ["c1"],
              },
            ],
            claims: [
              {
                id: "c1",
                text: "Evidence spans multiple lines.",
                quote: "Exact evidence spans multiple lines",
              },
            ],
          }),
        };
      }
      return fakeLlm.complete(request);
    },
  };
  const result = await compileWiki({ root, llmProvider: provider });
  const graph = JSON.parse(await readFile(result.graphPath, "utf8"));
  assert.equal(graph.claims[0]?.quote, "Exact evidence spans\nmultiple lines");
});

test("relevant chunk analysis may omit an unused exclusion reason", async () => {
  const root = await workspace("chunk-optional-exclusion");
  await initWiki(root);
  await ingestContent("Agents reuse plans across related tasks.", "plans.txt", {
    root,
  });
  const provider: LlmProvider = {
    name: "optional-exclusion",
    async complete(request) {
      if (request.purpose === "source-analysis") {
        return {
          text: JSON.stringify({
            relevant: true,
            summary: "Plan reuse evidence.",
            concepts: [
              {
                id: "plan-reuse",
                title: "Plan reuse",
                definition: "Plans can be reused across related tasks.",
                claimIds: ["c1"],
              },
            ],
            claims: [
              {
                id: "c1",
                text: "Agents reuse plans.",
                quote: "Agents reuse plans across related tasks.",
              },
            ],
          }),
        };
      }
      return fakeLlm.complete(request);
    },
  };
  const result = await compileWiki({ root, llmProvider: provider });
  const graph = JSON.parse(await readFile(result.graphPath, "utf8"));
  assert.equal(graph.claims.length, 1);
});

test("chunk analysis maps PDF line-break dehyphenation back to exact text", async () => {
  const root = await workspace("chunk-dehyphenated-quote");
  await initWiki(root);
  await ingestContent(
    "Reliable long-horizon reasoning remains open for fron-\ntier models.",
    "hyphenated.txt",
    { root },
  );
  const provider: LlmProvider = {
    name: "dehyphenated-quote",
    async complete(request) {
      if (request.purpose === "source-analysis") {
        return {
          text: JSON.stringify({
            relevant: true,
            exclusionReason: "",
            summary: "Frontier reliability evidence.",
            concepts: [
              {
                id: "frontier",
                title: "Frontier reliability",
                definition: "Long-horizon reasoning remains open.",
                claimIds: ["c1"],
              },
            ],
            claims: [
              {
                id: "c1",
                text: "Long-horizon reasoning remains open.",
                quote:
                  "Reliable long-horizon reasoning remains open for frontier models.",
              },
            ],
          }),
        };
      }
      return fakeLlm.complete(request);
    },
  };
  const result = await compileWiki({ root, llmProvider: provider });
  const graph = JSON.parse(await readFile(result.graphPath, "utf8"));
  assert.equal(
    graph.claims[0]?.quote,
    "Reliable long-horizon reasoning remains open for fron-\ntier models.",
  );
});

test("ingestion normalizes and deduplicates by SHA-256", async () => {
  const root = await workspace("dedup");
  await initWiki(root);
  const source = path.join(root, "source.md");
  await writeFile(
    source,
    "# Retrieval\n\nRetrieval systems index evidence.\r\n",
    "utf8",
  );
  const first = await ingest(source, {
    root,
    now: () => new Date("2026-01-01T00:00:00Z"),
  });

  const duplicate = await ingestContent(
    "# Retrieval\n\nRetrieval systems index evidence.",
    "other.md",
    {
      root,
      mediaType: "text/markdown",
    },
  );
  assert.equal(first.deduplicated, false);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(first.artifact.hash, duplicate.artifact.hash);
  assert.equal(first.artifact.provenance.input, source);
  assert.equal(duplicate.artifact.provenanceHistory.length, 2);
  assert.equal(
    (await loadRawManifest({ root })).entries[0]?.origins[0]?.restoreMode,
    "none",
  );
});

test("local raw files restore from an external storage URI with hash verification", async () => {
  const root = await workspace("restore-local");
  await initWiki(root);
  const input = path.join(root, "input.txt");
  const storage = path.join(root, "storage", "input.txt");
  await mkdir(path.dirname(storage), { recursive: true });
  await Promise.all([
    writeFile(input, "portable raw evidence", "utf8"),
    writeFile(storage, "portable raw evidence", "utf8"),
  ]);
  const ingested = await ingest(input, {
    root,
    storageUri: pathToFileURL(storage).href,
  });
  await rm(input);

  const manifest = await loadRawManifest({ root });
  const origin = manifest.entries[0]?.origins[0];
  assert.equal(manifest.entries[0]?.sourceId, ingested.artifact.id);
  assert.equal(origin?.restoreMode, "copy");
  assert.ok(origin?.originalSha256);

  const restored = await restoreRaw({ root });
  assert.equal(restored.restored, 1);
  assert.equal(
    await readFile(path.join(root, "raw", origin!.targetPath!), "utf8"),
    "portable raw evidence",
  );
  const verified = await restoreRaw({ root });
  assert.equal(verified.verified, 1);
});

test("URL raw restore rejects changed content and preserves the target", async () => {
  const root = await workspace("restore-url");
  await initWiki(root);
  const url = "https://example.invalid/source.txt";
  await ingest(url, {
    root,
    fetch: async () =>
      new Response("original remote evidence", {
        headers: { "content-type": "text/plain" },
      }),
  });

  const mismatch = await restoreRaw({
    root,
    fetch: async () =>
      new Response("changed remote evidence", {
        headers: { "content-type": "text/plain" },
      }),
  });
  assert.equal(mismatch.errors, 1);
  const manifest = await loadRawManifest({ root });
  const target = manifest.entries[0]?.origins[0]?.targetPath;
  await assert.rejects(() => readFile(path.join(root, "raw", target!)));

  const restored = await restoreRaw({
    root,
    fetch: async () =>
      new Response("original remote evidence", {
        headers: { "content-type": "text/plain" },
      }),
  });
  assert.equal(restored.restored, 1);
});

test("raw restore reports generated evidence and blocks path traversal", async () => {
  const root = await workspace("restore-safety");
  await initWiki(root);
  await ingestContent("Generated experiment evidence", "exp-restore", {
    root,
    provenanceKind: "experiment",
  });
  const unavailable = await restoreRaw({ root });
  assert.equal(unavailable.unavailable, 1);

  const manifestPath = path.join(root, "raw", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.entries[0].origins[0].restoreMode = "copy";
  manifest.entries[0].origins[0].targetPath = "../escape.txt";
  manifest.entries[0].origins[0].storageUri = pathToFileURL(
    path.join(root, "storage.txt"),
  ).href;
  await writeFile(
    path.join(root, "storage.txt"),
    "Generated experiment evidence",
  );
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const traversal = await restoreRaw({ root });
  assert.equal(traversal.errors, 1);
  await assert.rejects(() => readFile(path.join(root, "escape.txt")));
});

test("init backfills manifests for legacy processed sources", async () => {
  const root = await workspace("manifest-backfill");
  await initWiki(root);
  const ingested = await ingestContent(
    "Legacy processed evidence with no original raw manifest.",
    "legacy.md",
    { root, mediaType: "text/markdown" },
  );
  await rm(path.join(root, "raw", "manifest.json"));
  await initWiki(root);

  const manifest = await loadRawManifest({ root });
  assert.equal(manifest.entries[0]?.sourceId, ingested.artifact.id);
  assert.equal(manifest.entries[0]?.origins[0]?.originalSha256, undefined);
});

test("URL ingestion uses injected fetch and preserves URL provenance", async () => {
  const root = await workspace("url-ingest");
  await initWiki(root);
  const url = "https://example.invalid/research.md";
  const result = await ingest(url, {
    root,
    fetch: async (_input, init) => {
      assert.ok(init?.signal);
      return new Response(
        "# Remote research\n\nRemote evidence is preserved with its source URL.",
        { headers: { "content-type": "text/markdown; charset=utf-8" } },
      );
    },
  });

  assert.equal(result.artifact.provenance.kind, "url");
  assert.equal(result.artifact.provenance.url, url);
  assert.match(result.artifact.content, /Remote evidence/);
});

test("Crossref search skips incomplete records while honoring result limits", async () => {
  let requestedRows = "";
  const provider = new CrossrefProvider(async (input) => {
    const url = new URL(String(input));
    requestedRows = url.searchParams.get("rows") ?? "";
    return new Response(
      JSON.stringify({
        message: {
          items: [
            { DOI: "10.0000/incomplete", URL: "https://doi.org/incomplete" },
            {
              DOI: "10.0000/complete",
              title: ["Complete evidence"],
              URL: "https://doi.org/complete",
              abstract: "<p>Evidence-bearing abstract.</p>",
            },
          ],
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });

  const results = await provider.search("evidence", { limit: 1 });
  assert.equal(requestedRows, "5");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.title, "Complete evidence");
});

test("PDF ingestion extracts text through the installed parser", async () => {
  const root = await workspace("pdf");
  await initWiki(root);
  const file = path.join(root, "evidence.pdf");
  await writeFile(file, await minimalPdf("PDF evidence is preserved"));
  const result = await ingest(file, { root });
  assert.equal(result.artifact.mediaType, "application/pdf");
  assert.match(result.artifact.content, /PDF evidence is preserved/);
});

test("compile, query, reflect, and lint preserve evidence", async () => {
  const root = await workspace("compile");
  await initWiki(root);
  await ingestContent(
    "Vector retrieval indexes document embeddings. Retrieval returns evidence for a query. Citations identify the supporting source.",
    "retrieval-notes.md",
    { root, title: "Retrieval notes", mediaType: "text/markdown" },
  );
  const compiled = await compileWiki({
    root,
    llmProvider: fakeLlm,
    now: () => new Date("2026-02-03T04:05:06Z"),
  });
  assert.equal(compiled.sources, 1);
  assert.ok(compiled.concepts > 0);
  const query = await queryWiki("How does retrieval return evidence?", {
    root,
    llmProvider: fakeLlm,
  });
  assert.ok(query.matches.length > 0);
  assert.equal(query.matches.length, 1);
  assert.equal(query.citations.length, 1);
  const lint = await lintWiki({ root });
  assert.equal(lint.ok, true, JSON.stringify(lint.errors));
  const reflection = await reflectWiki({
    root,
    llmProvider: fakeLlm,
    now: () => new Date("2026-02-04T00:00:00Z"),
  });
  assert.match(
    await readFile(reflection.reflectionPath, "utf8"),
    /LLM knowledge reflection/i,
  );
  assert.match(
    await readFile(path.join(root, "meta", "capability_map.md"), "utf8"),
    /Processed sources: 1/,
  );
  assert.match(
    await readFile(path.join(root, "meta", "evolution_log.md"), "utf8"),
    /LLM knowledge reflection/,
  );
});

test("query refuses to invent an answer without evidence", async () => {
  const root = await workspace("no-evidence");
  await initWiki(root);
  await compileWiki({ root, llmProvider: fakeLlm });
  const result = await queryWiki("unrepresented quasar taxonomy", {
    root,
    llmProvider: fakeLlm,
  });
  assert.deepEqual(result.matches, []);
  assert.match(result.answer, /Evidence is insufficient/);
  const stopWordsOnly = await queryWiki("what is the", {
    root,
    llmProvider: fakeLlm,
  });
  assert.deepEqual(stopWordsOnly.matches, []);
  await assert.rejects(
    () => queryWiki("anything", { root, limit: 0 }),
    /Query limit/,
  );
});

test("malformed and unsupported inputs fail", async () => {
  const root = await workspace("malformed");
  await initWiki(root);
  await assert.rejects(
    () => ingestContent("   ", "empty.txt", { root }),
    /no usable content/,
  );
  await assert.rejects(
    () =>
      ingestContent("{not-json}", "bad.json", {
        root,
        mediaType: "application/json",
      }),
    /Malformed JSON/,
  );
  const unsupported = path.join(root, "image.png");
  await writeFile(unsupported, "not an image", "utf8");
  await assert.rejects(
    () => ingest(unsupported, { root }),
    /Unsupported input type/,
  );
  const invalidUtf8 = path.join(root, "invalid.txt");
  await writeFile(invalidUtf8, Buffer.from([0xff, 0xfe, 0xfd]));
  await assert.rejects(() => ingest(invalidUtf8, { root }), /not valid UTF-8/);
  const portable = path.join(root, "portable.txt");
  await writeFile(portable, "portable", "utf8");
  await assert.rejects(
    () => ingest(portable, { root, storageUri: "relative/storage.txt" }),
    /storageUri must be/,
  );
  assert.deepEqual(
    (await readdir(path.join(root, "sources"))).filter((name) =>
      name.endsWith(".json"),
    ),
    [],
  );
  await writeFile(path.join(root, ".llmwiki-config.json"), "{bad", "utf8");
  await assert.rejects(() => loadConfig(root), /Malformed JSON/);
});

test("lint reports broken internal links and missing source artifacts", async () => {
  const root = await workspace("lint-errors");
  await initWiki(root);
  const wikiFile = path.join(root, "wiki", "ideas", "broken.md");
  await writeFile(
    wikiFile,
    `---
title: "Broken"
slug: "broken"
generated: "true"
type: "source"
source_id: "missing"
---

<!-- llmwiki:generated:start -->
# Broken

This generated page intentionally contains enough text to pass the thin-page threshold while linking to [[does-not-exist.md]].
<!-- llmwiki:generated:end -->
`,
    "utf8",
  );
  await writeFile(
    path.join(root, "wiki", "concepts", "stale.md"),
    `---
title: "Stale concept"
slug: "stale-concept"
generated: "true"
type: "concept"
provenance:
  - "missing-concept-source"
---

<!-- llmwiki:generated:start -->
# Stale concept

This generated concept page intentionally references a processed source that does not exist so lint can report stale provenance.
<!-- llmwiki:generated:end -->
`,
    "utf8",
  );
  const result = await lintWiki({ root });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((entry) => entry.code === "broken-internal-link"),
  );
  assert.ok(
    result.errors.some((entry) => entry.code === "missing-source-artifact"),
  );
  assert.ok(
    result.errors.some((entry) =>
      entry.message.includes("missing-concept-source"),
    ),
  );
});

test("lint ignores wiki-like syntax inside generated source text", async () => {
  const root = await workspace("lint-source-text");
  await initWiki(root);
  await ingestContent(
    "Chemical notation [[C=C(Cl]] and matrix notation [[A]] are source evidence, not Wiki links.",
    "notation.txt",
    { root },
  );
  await compileWiki({ root, llmProvider: fakeLlm });
  const result = await lintWiki({ root });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("fake search imports evidence and learn records actual offline work", async () => {
  const root = await workspace("learn");
  await initWiki(root);
  await ingestContent(
    "Sparse retrieval uses lexical term matching for document ranking.",
    "seed.md",
    {
      root,
      title: "Sparse retrieval",
    },
  );
  await compileWiki({ root, llmProvider: fakeLlm });
  const calls: string[] = [];
  const fakeProvider: SearchProvider = {
    name: "deterministic-fake",
    async search(query, options): Promise<SearchResult[]> {
      calls.push(query);
      return [
        {
          id: `fake-${calls.length}`,
          title: `Evidence for ${query}`,
          url: `https://example.invalid/evidence/${calls.length}`,
          abstract: `This deterministic offline abstract reports evidence relevant to ${query}.`,
          snippet: `Evidence relevant to ${query}.`,
          provider: this.name,
        },
      ].slice(0, options.limit);
    },
  };
  const search = await searchWiki("lexical retrieval", {
    root,
    provider: fakeProvider,
    llmProvider: fakeLlm,
    importResults: true,
    limit: 1,
  });
  assert.equal(search.provider, "deterministic-fake");
  assert.equal(search.imported.length, 1);
  await writeFile(
    path.join(root, "meta", "gaps.json"),
    JSON.stringify({
      version: 1,
      gaps: [
        {
          priority: 1,
          description: "Need independent retrieval evidence.",
          searchQuery: "independent retrieval evidence",
        },
      ],
    }),
    "utf8",
  );
  const learned = await learnWiki({
    root,
    llmProvider: fakeLlm,
    provider: fakeProvider,
    gapLimit: 1,
    limit: 1,
    now: () => new Date("2026-03-01T00:00:00Z"),
  });
  assert.equal(learned.selectedGaps.length, 1);
  assert.equal(learned.imported, 1);
  assert.equal(learned.compiled, true);
  assert.match(
    await readFile(learned.logPath, "utf8"),
    /selected=1, imported=1/,
  );
  assert.match(
    await readFile(path.join(root, "meta", "evolution_log.md"), "utf8"),
    /learning selected=/,
  );
  assert.ok(calls.length >= 2);
});

test("learn forwards full-text options and shares one download budget", async () => {
  const root = await workspace("learn-full-text-budget");
  await initWiki(root);
  await writeFile(
    path.join(root, "meta", "gaps.json"),
    JSON.stringify({
      version: 1,
      gaps: [
        { priority: 1, description: "Gap one", searchQuery: "gap one" },
        { priority: 2, description: "Gap two", searchQuery: "gap two" },
      ],
    }),
    "utf8",
  );
  const provider: SearchProvider = {
    name: "offline-full-text",
    async search(query) {
      const slug = query.replace(/\s+/g, "-");
      return [
        {
          id: slug,
          title: `Evidence for ${query}`,
          url: `https://example.invalid/${slug}`,
          provider: this.name,
          abstract: `Metadata evidence for ${query}.`,
          fullTextLocations: [
            {
              url: `https://example.invalid/${slug}.html`,
              kind: "html",
              openAccess: true,
              source: this.name,
            },
          ],
        },
      ];
    },
  };
  let fetches = 0;
  const result = await learnWiki({
    root,
    provider,
    llmProvider: fakeLlm,
    gapLimit: 2,
    limit: 1,
    fullText: true,
    oaOnly: true,
    maxDownloads: 1,
    maxFileBytes: 10_000,
    onFullTextFailure: "metadata",
    fetch: async (input) => {
      fetches++;
      return new Response(
        `<article>${`Full text for ${String(input)}. `.repeat(60)}</article>`,
        {
          headers: { "content-type": "text/html" },
        },
      );
    },
  });
  assert.equal(fetches, 1);
  assert.equal(
    result.searches.reduce(
      (total, search) => total + (search.fullTextAttempts ?? 0),
      0,
    ),
    1,
  );
  assert.equal(
    result.searches.reduce(
      (total, search) => total + (search.fullTextDownloads ?? 0),
      0,
    ),
    1,
  );
  assert.equal(result.imported, 2);
  assert.ok(
    result.searches
      .flatMap((search) => search.errors)
      .some((error) => error.includes("maxDownloads limit")),
  );
});

test("corroboration targets a weak Claim and recompiles independent evidence", async () => {
  const root = await workspace("claim-corroboration");
  await initWiki(root);
  const configPath = path.join(root, ".llmwiki-config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.llm.maxRelationshipCandidates = 1;
  await writeFile(configPath, JSON.stringify(config));
  await ingestContent(
    "BCER decouples planning from execution for dependable workflows.",
    "target.txt",
    { root },
  );
  await ingestContent(
    "BCER separates planning and execution in clinical workflows.",
    "decoy.txt",
    { root },
  );
  let targetId = "";
  let initialClaimIds = new Set<string>();
  let planCalls = 0;
  const llm: LlmProvider = {
    name: "corroboration",
    async complete(request) {
      if (request.purpose === "corroboration-plan") planCalls++;
      if (request.purpose === "relationship-analysis") {
        const pairs = JSON.parse(
          request.prompt.slice(request.prompt.lastIndexOf("\n") + 1),
        ) as Array<{
          from: string;
          to: string;
          fromClaim: { statement: string };
          toClaim: { statement: string };
        }>;
        return {
          text: JSON.stringify({
            edges: pairs
              .filter(
                (pair) =>
                  Boolean(targetId) &&
                  [pair.from, pair.to].includes(targetId) &&
                  [pair.from, pair.to].some((id) => !initialClaimIds.has(id)),
              )
              .map((pair) => ({
                from: pair.from,
                to: pair.to,
                type: "supports",
                explanation:
                  "The independent hierarchy supports separated planning and execution.",
              })),
          }),
        };
      }
      return fakeLlm.complete(request);
    },
  };
  const initial = await compileWiki({ root, llmProvider: llm });
  const registry = JSON.parse(await readFile(initial.claimsPath!, "utf8"));
  initialClaimIds = new Set(
    registry.claims.map((claim: { id: string }) => claim.id),
  );
  targetId = registry.claims.find((claim: { statement: string }) =>
    claim.statement.startsWith("BCER decouples"),
  ).id as string;
  const provider: SearchProvider = {
    name: "independent",
    async search(query) {
      return [
        {
          id: "independent-study",
          title: "Independent long-running agent study",
          url: "https://example.test/independent",
          abstract:
            "Hierarchical recovery separates a controller and worker for dependable MRI workflows.",
          provider: "independent",
          openAccess: true,
        },
      ];
    },
  };
  const result = await corroborateWiki({
    root,
    claimIds: [targetId],
    provider,
    llmProvider: llm,
    limit: 1,
    adjudicate: false,
    maxLlmTokens: 100_000,
  });
  assert.equal(result.targets.length, 1);
  assert.equal(result.compiled, true);
  assert.ok(result.imported >= 1);
  assert.equal(result.after[0]?.evidenceStatus, "corroborated");
  assert.ok((result.after[0]?.independentSupportSources ?? 0) >= 1);
  assert.ok(await readFile(result.planPath, "utf8"));
  const completedPlan = JSON.parse(await readFile(result.planPath, "utf8"));
  completedPlan.state = "planned";
  completedPlan.baselineSourceIds = registry.sources.map(
    (source: { id: string }) => source.id,
  );
  await writeFile(result.planPath, JSON.stringify(completedPlan));
  await corroborateWiki({
    root,
    provider,
    llmProvider: llm,
    limit: 1,
    adjudicate: false,
    maxLlmTokens: 100_000,
  });
  assert.equal(planCalls, 1);
  assert.equal(
    JSON.parse(await readFile(result.planPath, "utf8")).state,
    "completed",
  );
  await compileWiki({ root, llmProvider: llm });
  const persistedConfidence = JSON.parse(
    await readFile(path.join(root, "meta", "claim_confidence.json"), "utf8"),
  ).claims.find((claim: { claimId: string }) => claim.claimId === targetId);
  assert.equal(persistedConfidence.evidenceStatus, "corroborated");
});

test("contradiction adjudication persists constrained resolutions and pages", async () => {
  const root = await workspace("contradiction-adjudication");
  const initialized = await initWiki(root);
  const meta = path.join(root, "meta");
  const from = "claim-" + "a".repeat(32);
  const to = "claim-" + "b".repeat(32);
  const third = "claim-" + "c".repeat(32);
  const claims = [
    {
      id: from,
      sourceId: "source-a",
      statement: "The intervention improves reliability.",
      quote: "improves reliability",
      sourceTitle: "Study A",
      sourcePath: "wiki/sources/study-a.md",
    },
    {
      id: to,
      sourceId: "source-b",
      statement: "The intervention does not improve reliability.",
      quote: "does not improve reliability",
      sourceTitle: "Study B",
      sourcePath: "wiki/sources/study-b.md",
    },
    {
      id: third,
      sourceId: "source-c",
      statement: "The intervention helps only in a constrained setting.",
      quote: "helps only in a constrained setting",
      sourceTitle: "Study C",
      sourcePath: "wiki/sources/study-c.md",
    },
  ];
  await writeFile(
    path.join(meta, "claims.json"),
    JSON.stringify({
      version: 1,
      sources: [
        { id: "source-a", title: "Study A" },
        { id: "source-b", title: "Study B" },
        { id: "source-c", title: "Study C" },
      ],
      claims,
    }),
  );
  await writeFile(
    path.join(meta, "claim_graph.json"),
    JSON.stringify({
      version: 1,
      edges: [
        {
          from,
          to,
          type: "contradicts",
          explanation: "The reported outcomes oppose each other.",
        },
        {
          from: to,
          to: third,
          type: "contradicts",
          explanation: "The reported scopes oppose each other.",
        },
      ],
    }),
  );
  await writeFile(
    path.join(meta, "claim_confidence.json"),
    JSON.stringify({
      claims: claims.map((claim) => ({
        claimId: claim.id,
        confidence: 40,
        sourceScore: 60,
        independentSupportSources: 0,
        supportCount: 0,
        qualifyCount: 0,
        duplicateCount: 0,
        contradictionCount: 1,
        evidenceStatus: "contested",
        reasons: [],
        penalties: ["1 contradiction"],
      })),
    }),
  );
  await writeFile(
    path.join(meta, "source_scores.json"),
    JSON.stringify({
      sources: ["source-a", "source-b", "source-c"].map((sourceId) => ({
        sourceId,
        score: 60,
        components: {},
        positiveReasons: [],
        penalties: [],
        evidenceClass: "full-text",
        sourceKind: "file",
        identifiers: {},
      })),
    }),
  );
  let adjudicationCalls = 0;
  const partialAdjudicator: LlmProvider = {
    name: "partial-adjudicator",
    async complete(request) {
      if (request.purpose !== "contradiction-adjudication") {
        return fakeLlm.complete(request);
      }
      adjudicationCalls++;
      const entries = JSON.parse(
        request.prompt.slice(request.prompt.lastIndexOf("\n") + 1),
      ) as Array<{ from: string; to: string; claims: Array<{ id: string }> }>;
      const returned = adjudicationCalls === 1 ? entries.slice(0, 1) : entries;
      const batchClaimIds = [
        ...new Set(
          entries.flatMap((entry) => entry.claims.map((claim) => claim.id)),
        ),
      ];
      return {
        text: JSON.stringify({
          adjudications: returned.map((entry) => ({
            from: entry.from,
            to: entry.to,
            resolution: "context-dependent",
            rationale: "The supplied claims use different operating contexts.",
            evidenceClaimIds: batchClaimIds,
            evidenceNeeds: "A controlled comparison under matched scope.",
          })),
        }),
      };
    },
  };
  const result = await adjudicateWiki({
    root: initialized.root,
    llmProvider: partialAdjudicator,
    maxLlmTokens: 20_000,
  });
  assert.equal(result.adjudications[0]?.resolution, "context-dependent");
  assert.equal(result.adjudications.length, 2);
  assert.equal(adjudicationCalls, 2);
  const pages = await readdir(path.join(root, "wiki", "contradictions"));
  const page = await readFile(
    path.join(root, "wiki", "contradictions", pages[0]!),
    "utf8",
  );
  assert.match(page, /\*\*context-dependent\*\*/);
  assert.match(page, /controlled comparison/i);
});

test("experiment evidence is accepted as explicit provenance", async () => {
  const root = await workspace("experiment-provenance");
  await initWiki(root);
  await ingestContent(
    "Experiment exp-1 measured 125 operations per second under the reviewed local sandbox.",
    "exp-1",
    {
      root,
      title: "Experiment exp-1",
      provenanceKind: "experiment",
      mediaType: "application/vnd.llmwiki.experiment+text",
    },
  );
  await compileWiki({ root, llmProvider: fakeLlm });
  const lint = await lintWiki({ root });
  assert.equal(lint.ok, true, JSON.stringify(lint.errors));
});

test("learn does not search when the compiler recorded no gaps", async () => {
  const root = await workspace("no-gaps-learn");
  await initWiki(root);
  await compileWiki({ root, llmProvider: fakeLlm });
  const provider: SearchProvider = {
    name: "must-not-run",
    async search() {
      throw new Error("search should not run");
    },
  };
  const result = await learnWiki({ root, provider, llmProvider: fakeLlm });
  assert.deepEqual(result.selectedGaps, []);
  assert.equal(result.imported, 0);
  assert.equal(result.compiled, false);
});

test("learn recompiles evidence imported before an interrupted prior run", async () => {
  const root = await workspace("learn-recovers-uncompiled-source");
  await initWiki(root);
  await ingestContent("Initial compiled evidence.", "initial.txt", { root });
  await compileWiki({ root, llmProvider: fakeLlm });
  await ingestContent(
    "Evidence persisted before compilation failed.",
    "pending.txt",
    {
      root,
    },
  );
  const provider: SearchProvider = {
    name: "duplicate-only",
    async search() {
      return [
        {
          id: "duplicate",
          title: "Already known",
          url: "https://example.test/duplicate",
          abstract: "Duplicate candidate.",
          provider: "duplicate-only",
        },
      ];
    },
  };
  const llm: LlmProvider = {
    name: "recovery",
    async complete(request) {
      if (request.purpose === "screening") {
        return {
          text: JSON.stringify({
            relevant: true,
            duplicate: true,
            reason: "Already represented.",
          }),
        };
      }
      return fakeLlm.complete(request);
    },
  };
  const result = await learnWiki({
    root,
    provider,
    llmProvider: llm,
    gapLimit: 1,
    limit: 1,
    maxLlmTokens: 100_000,
  });
  assert.equal(result.imported, 0);
  assert.equal(result.compiled, true);
  const status = await getStatus({ root });
  assert.equal(status.sourceArtifacts, 2);
});

test("semantic operations require approval and a non-empty focus", async () => {
  const root = await workspace("semantic-boundaries");
  await initWiki(root);
  await ingestContent(
    "Approved evidence is needed for semantic compilation.",
    "evidence.txt",
    { root },
  );
  await assert.rejects(() => compileWiki({ root }), /explicit approval/);
  const configPath = path.join(root, ".llmwiki-config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.researchFocus = "";
  await writeFile(configPath, JSON.stringify(config), "utf8");
  await assert.rejects(
    () => compileWiki({ root, llmProvider: fakeLlm }),
    /non-empty researchFocus/,
  );
});

test("LLM cache keys include focus and prompt-affecting limits", async () => {
  const root = await workspace("cache-focus");
  await initWiki(root);
  await ingestContent(
    "Cache evidence has a complete sentence for claims.",
    "cache.txt",
    { root },
  );
  let analyses = 0;
  const counting: LlmProvider = {
    name: "counting",
    async complete(request) {
      if (request.purpose === "source-analysis") analyses++;
      return fakeLlm.complete(request);
    },
  };
  await compileWiki({ root, llmProvider: counting });
  await compileWiki({ root, llmProvider: counting });
  assert.equal(analyses, 1);
  const configPath = path.join(root, ".llmwiki-config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.researchFocus = "a changed focus";
  await writeFile(configPath, JSON.stringify(config), "utf8");
  await compileWiki({ root, llmProvider: counting });
  assert.equal(analyses, 2);
  config.llm.sourceInputChars = 20_000;
  await writeFile(configPath, JSON.stringify(config), "utf8");
  await compileWiki({ root, llmProvider: counting });
  assert.equal(analyses, 2);
  config.llm.analysisOutputTokens = 7_000;
  await writeFile(configPath, JSON.stringify(config), "utf8");
  await compileWiki({ root, llmProvider: counting });
  assert.equal(analyses, 3);
});

test("claim registry topics and relationship batches are complete and cached", async () => {
  const root = await workspace("claim-registry-topics");
  await initWiki(root);
  const sentences = Array.from(
    { length: 6 },
    (_, index) => `Planning tool recovery evidence number ${index + 1}.`,
  );
  await ingestContent(sentences.join(" "), "one.txt", { root });
  await ingestContent(
    sentences
      .map((sentence) => sentence.replace("Planning", "Evaluation"))
      .join(" "),
    "two.txt",
    { root },
  );
  await ingestContent(
    sentences
      .map((sentence) => sentence.replace("Planning", "Alignment"))
      .join(" "),
    "three.txt",
    { root },
  );
  const calls: Record<string, number> = {};
  const registryProvider: LlmProvider = {
    name: "registry",
    async complete(request) {
      calls[request.purpose] = (calls[request.purpose] ?? 0) + 1;
      if (request.purpose === "source-analysis") {
        const content = request.prompt.slice(
          request.prompt.indexOf("\n\n") + 2,
        );
        const claims = [...content.matchAll(/[^.]+\./g)].map(
          (match, index) => ({
            id: `c${index + 1}`,
            text: match[0]!.trim(),
            quote: match[0]!.trim(),
          }),
        );
        return {
          text: JSON.stringify({
            relevant: true,
            exclusionReason: "in scope",
            summary: "Registry evidence.",
            concepts: [],
            claims,
          }),
        };
      }
      if (request.purpose === "synthesis") {
        const inputLine = request.prompt
          .split("\n")
          .find((line) => line.startsWith("["));
        const input = JSON.parse(inputLine ?? "[]") as Array<{
          sourceId: string;
          claims: Array<{ id: string }>;
        }>;
        const limit = Number(
          request.prompt.match(/at most 8 concepts, (\d+) claims/)?.[1] ?? 16,
        );
        const selected = input
          .flatMap((source) =>
            source.claims.map((claim) => ({
              ...claim,
              sourceId: source.sourceId,
            })),
          )
          .slice(0, limit);
        return {
          text: JSON.stringify({
            concepts: [
              {
                id: "registry",
                title: "Registry",
                definition: "Selected registry evidence.",
                claimIds: selected.map((claim) => claim.id),
              },
            ],
            claims: selected.map((claim) => ({
              id: claim.id,
              conceptIds: ["registry"],
            })),
            contradictions: [],
            gaps: [],
          }),
        };
      }
      if (request.purpose === "topic-synthesis")
        return {
          text: JSON.stringify({
            overview: "Topic evidence is synthesized without changing claims.",
            conceptLabels: ["Evidence"],
            summaryClaimIds: [],
          }),
        };
      if (request.purpose === "relationship-analysis") {
        const candidates = JSON.parse(
          request.prompt.slice(request.prompt.lastIndexOf("\n") + 1),
        ) as Array<{ from: string; to: string }>;
        const pair = candidates[0];
        const types = ["supports", "contradicts", "qualifies", "duplicate"];
        return {
          text: JSON.stringify({
            edges: pair
              ? [
                  {
                    from: pair.to,
                    to: pair.from,
                    type: types[(calls[request.purpose] - 1) % types.length],
                    explanation: "Validated candidate relationship.",
                  },
                ]
              : [],
          }),
        };
      }
      if (request.purpose === "query") {
        const candidates = JSON.parse(
          request.prompt
            .split("Candidates: ")[1]
            ?.split("\nContradictions: ")[0] ?? "[]",
        ) as Array<{ id: string }>;
        return {
          text: JSON.stringify({
            answer: "Registry evidence answer.",
            citations: candidates[0] ? [candidates[0].id] : [],
          }),
        };
      }
      throw new Error(`Unexpected request ${request.purpose}`);
    },
  };
  const first = await compileWiki({ root, llmProvider: registryProvider });
  const registry = JSON.parse(
    await readFile(path.join(root, "meta", "claims.json"), "utf8"),
  ) as {
    claims: Array<{ id: string; statement: string; topicIds: string[] }>;
    topics: Array<{ id: string }>;
  };
  const graph = JSON.parse(
    await readFile(path.join(root, "meta", "claim_graph.json"), "utf8"),
  ) as { edges: Array<{ type: string; from: string; to: string }> };
  const summary = JSON.parse(
    await readFile(path.join(root, "meta", "knowledge_graph.json"), "utf8"),
  ) as { claims: Array<{ id: string }> };
  assert.ok(registry.claims.length > 16);
  assert.equal(first.summaryClaimCount, 16);
  assert.ok(
    registry.claims.every(
      (claim) => claim.id.startsWith("claim-") && claim.topicIds.length > 0,
    ),
  );
  assert.ok(registry.topics.length > 0);
  assert.ok(
    (await readdir(path.join(root, "wiki", "topics"))).some((file) =>
      file.endsWith(".md"),
    ),
  );
  assert.deepEqual(
    new Set(graph.edges.map((edge) => edge.type)),
    new Set(["supports", "contradicts", "qualifies", "duplicate"]),
  );
  assert.ok(graph.edges.every((edge) => edge.from < edge.to));
  const summaryIds = new Set(summary.claims.map((claim) => claim.id));
  assert.ok(
    graph.edges.some(
      (edge) => !summaryIds.has(edge.from) || !summaryIds.has(edge.to),
    ),
  );
  const nonSummary = registry.claims.find((claim) => !summaryIds.has(claim.id));
  assert.ok(nonSummary);
  const query = await queryWiki(nonSummary!.statement, {
    root,
    llmProvider: registryProvider,
  });
  assert.ok(query.citations.includes(nonSummary!.id));
  const firstIds = registry.claims.map((claim) => claim.id);
  const configPath = path.join(root, ".llmwiki-config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.llm.summaryClaimLimit = 1;
  await writeFile(configPath, JSON.stringify(config), "utf8");
  await compileWiki({ root, llmProvider: registryProvider });
  const narrowedSummary = JSON.parse(
    await readFile(path.join(root, "meta", "knowledge_graph.json"), "utf8"),
  ) as { claims: Array<{ id: string }> };
  const narrowedIds = new Set(narrowedSummary.claims.map((claim) => claim.id));
  assert.equal(narrowedIds.size, 1);
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.type === "contradicts" &&
        (!narrowedIds.has(edge.from) || !narrowedIds.has(edge.to)),
    ),
  );
  const migratedCallCount = Object.values(calls).reduce(
    (total, count) => total + count,
    0,
  );
  await compileWiki({ root, llmProvider: registryProvider });
  assert.deepEqual(
    (
      JSON.parse(
        await readFile(path.join(root, "meta", "claims.json"), "utf8"),
      ) as {
        claims: Array<{ id: string }>;
      }
    ).claims.map((claim) => claim.id),
    firstIds,
  );
  assert.equal(
    Object.values(calls).reduce((total, count) => total + count, 0),
    migratedCallCount,
  );
});

test("screening includes focus and existing source index", async () => {
  const root = await workspace("screening-context");
  await initWiki(root);
  const existing = await ingestContent(
    "Existing retrieval evidence.",
    "existing.txt",
    { root, title: "Existing source" },
  );
  let screeningPrompt = "";
  const screening: LlmProvider = {
    name: "screening",
    async complete(request) {
      if (request.purpose === "screening") {
        screeningPrompt = request.prompt;
        return {
          text: JSON.stringify({
            relevant: true,
            duplicate: true,
            reason: "same evidence",
          }),
        };
      }
      return fakeLlm.complete(request);
    },
  };
  const provider: SearchProvider = {
    name: "offline",
    async search() {
      return [
        {
          id: "duplicate",
          title: "Candidate",
          url: "https://example.invalid/candidate",
          abstract: "Candidate evidence.",
          provider: "offline",
        },
      ];
    },
  };
  const result = await searchWiki("retrieval", {
    root,
    provider,
    importResults: true,
    llmProvider: screening,
  });
  assert.equal(result.imported.length, 0);
  assert.match(screeningPrompt, /Research focus:/);
  assert.match(screeningPrompt, new RegExp(existing.artifact.id));
  assert.match(screeningPrompt, /Existing source/);
});

test("LLM JSON errors preserve structured usage", async () => {
  const truncated: LlmProvider = {
    name: "truncated",
    async complete() {
      return {
        text: "{",
        usage: { inputTokens: 11, outputTokens: 7 },
        stopReason: "max_tokens",
      };
    },
  };
  await assert.rejects(
    () =>
      requestJson(
        truncated,
        { purpose: "query", prompt: "x", maxTokens: 1 },
        () => true,
      ),
    (error: unknown) =>
      error instanceof WikiLlmResponseError &&
      error.inputTokens === 11 &&
      error.outputTokens === 7 &&
      error.stopReason === "max_tokens",
  );
  const malformed: LlmProvider = {
    name: "bad",
    async complete() {
      return {
        text: 'prefix {"ok":true}',
        usage: { inputTokens: 3, outputTokens: 2 },
      };
    },
  };
  await assert.rejects(
    () =>
      requestJson(
        malformed,
        { purpose: "query", prompt: "x", maxTokens: 1 },
        () => true,
      ),
    (error: unknown) =>
      error instanceof WikiLlmResponseError &&
      error.inputTokens === 3 &&
      error.responseText === 'prefix {"ok":true}',
  );
});

test("LLM token budgets block calls before spend", async () => {
  let calls = 0;
  const provider: LlmProvider = {
    name: "must-not-run",
    async complete() {
      calls++;
      return { text: "{}" };
    },
  };
  await assert.rejects(
    () =>
      requestJson(
        provider,
        {
          purpose: "query",
          prompt: "A prompt that cannot fit the configured budget.",
          maxTokens: 128,
        },
        () => true,
        new LlmUsageTracker(1),
      ),
    /cannot fit within the remaining token budget/,
  );
  assert.equal(calls, 0);
  assert.equal(cleanModel("claude-haiku-4.5[1m]"), "claude-haiku-4.5");
});

test("LLM token budgets reduce output allowance to fit the operation", async () => {
  let requestedMaxTokens = 0;
  const provider: LlmProvider = {
    name: "bounded",
    async complete(request) {
      requestedMaxTokens = request.maxTokens;
      return {
        text: JSON.stringify({ ok: true }),
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
  };
  await requestJson(
    provider,
    {
      purpose: "query",
      prompt: "Short prompt",
      maxTokens: 400,
    },
    () => true,
    new LlmUsageTracker(500),
  );
  assert.ok(requestedMaxTokens >= 128);
  assert.ok(requestedMaxTokens < 400);
});

test("compile drops ungrounded claims and normalizes asymmetric synthesis mappings", async () => {
  const quoteRoot = await workspace("quote-mismatch");
  await initWiki(quoteRoot);
  await ingestContent("Grounded evidence is exact.", "grounded.txt", {
    root: quoteRoot,
  });
  const badQuote: LlmProvider = {
    name: "bad-quote",
    async complete(request) {
      if (request.purpose === "source-analysis") {
        return {
          text: JSON.stringify({
            relevant: true,
            exclusionReason: "in scope",
            summary: "Summary",
            concepts: [],
            claims: [
              {
                id: "c1",
                text: "Invented claim",
                quote: "This quote is absent.",
              },
            ],
          }),
        };
      }
      return fakeLlm.complete(request);
    },
  };
  const dropped = await compileWiki({
    root: quoteRoot,
    llmProvider: badQuote,
  });
  const droppedGraph = JSON.parse(await readFile(dropped.graphPath, "utf8"));
  assert.equal(droppedGraph.claims.length, 0);
  const droppedSource = await readFile(
    path.join(
      quoteRoot,
      "wiki",
      "sources",
      (await readdir(path.join(quoteRoot, "wiki", "sources")))[0]!,
    ),
    "utf8",
  );
  assert.match(droppedSource, /Rejected LLM claims/);
  assert.match(droppedSource, /quote is not present/);
  await compileWiki({ root: quoteRoot, llmProvider: badQuote });
  const cachedDroppedSource = await readFile(
    path.join(
      quoteRoot,
      "wiki",
      "sources",
      (await readdir(path.join(quoteRoot, "wiki", "sources")))[0]!,
    ),
    "utf8",
  );
  assert.match(cachedDroppedSource, /quote is not present/);

  const graphRoot = await workspace("graph-mismatch");
  await initWiki(graphRoot);
  await ingestContent("Bidirectional evidence is exact.", "graph.txt", {
    root: graphRoot,
  });
  await ingestContent(
    "Independent bidirectional evidence is also exact.",
    "graph-second.txt",
    { root: graphRoot },
  );
  let badGraphEntries:
    | Array<{
        sourceId: string;
        claims: Array<{ id: string; text: string; quote: string }>;
      }>
    | undefined;
  const badGraph: LlmProvider = {
    name: "bad-graph",
    async complete(request) {
      if (request.purpose !== "synthesis") {
        return fakeLlm.complete(request);
      }
      const inputLine = request.prompt
        .split("\n")
        .find((line) => line.startsWith("["));
      if (inputLine) {
        badGraphEntries = JSON.parse(inputLine) as typeof badGraphEntries;
      }
      const entries = badGraphEntries ?? [];
      const first = entries[0]!;
      const claimId = first.claims[0]!.id;
      return {
        text: JSON.stringify({
          concepts: [
            {
              id: "evidence",
              title: "Evidence",
              definition: "Grounded definition.",
              claimIds: [claimId],
            },
          ],
          claims: [
            {
              id: claimId,
              sourceId: first.sourceId,
              quote: first.claims[0]!.quote,
              text: first.claims[0]!.text,
              conceptIds: [],
            },
          ],
          contradictions: [],
          gaps: [],
        }),
      };
    },
  };
  const normalized = await compileWiki({
    root: graphRoot,
    llmProvider: badGraph,
  });
  const normalizedGraph = JSON.parse(
    await readFile(normalized.graphPath, "utf8"),
  );
  assert.deepEqual(normalizedGraph.claims[0]?.conceptIds, ["evidence"]);
});

test("compile recovers only complete gaps from truncated synthesis JSON", async () => {
  const root = await workspace("truncated-synthesis-recovery");
  await initWiki(root);
  await ingestContent("First synthesis evidence is exact.", "first.txt", {
    root,
  });
  await ingestContent("Second synthesis evidence is exact.", "second.txt", {
    root,
  });
  const provider: LlmProvider = {
    name: "truncated-synthesis",
    async complete(request) {
      if (request.purpose !== "synthesis") {
        return fakeLlm.complete(request);
      }
      const inputLine = request.prompt
        .split("\n")
        .find((line) => line.startsWith("["));
      const input = JSON.parse(inputLine ?? "[]") as Array<{
        claims: Array<{ id: string }>;
      }>;
      const claimId = input[0]!.claims[0]!.id;
      return {
        text: `{"concepts":[{"id":"c1","title":"Evidence","definition":"Validated evidence.","claimIds":["${claimId}"]}],"claims":[{"id":"${claimId}","conceptIds":["c1"]}],"contradictions":[],"gaps":[{"priority":1,"description":"Complete gap","searchQuery":"complete evidence"},{"priority":2,"description":"incomplete`,
        stopReason: "max_tokens",
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    },
  };
  const result = await compileWiki({ root, llmProvider: provider });
  const gaps = JSON.parse(await readFile(result.gapsPath, "utf8"));
  assert.equal(gaps.gaps.length, 1);
  assert.equal(gaps.gaps[0]?.description, "Complete gap");
});

test("compile recovers complete topic fields and Claim IDs from truncation", async () => {
  const root = await workspace("truncated-topic-recovery");
  await initWiki(root);
  await ingestContent("Planning evidence remains exact.", "planning.txt", {
    root,
  });
  await ingestContent("Recovery evidence remains exact.", "recovery.txt", {
    root,
  });
  const provider: LlmProvider = {
    name: "truncated-topic",
    async complete(request) {
      if (request.purpose === "topic-synthesis") {
        const claimId = request.prompt.match(/"id":"(claim-[a-f0-9]+)"/)?.[1];
        return {
          text: `{"overview":"Recovered overview","conceptLabels":["Reliability"],"summaryClaimIds":["${claimId}"`,
          stopReason: "max_tokens",
        };
      }
      if (request.purpose === "relationship-analysis") {
        return { text: JSON.stringify({ edges: [] }) };
      }
      return fakeLlm.complete(request);
    },
  };
  const result = await compileWiki({ root, llmProvider: provider });
  const registry = JSON.parse(await readFile(result.claimsPath!, "utf8"));
  assert.ok(
    registry.topics.some(
      (topic: { overview?: string; summaryClaimIds?: string[] }) =>
        topic.overview === "Recovered overview" &&
        (topic.summaryClaimIds?.length ?? 0) === 1,
    ),
  );
});

test("relationship analysis drops unknown pairs without losing valid edges", async () => {
  const root = await workspace("relationship-unknown-pair");
  await initWiki(root);
  await ingestContent("Agent reliability requires validation.", "first.txt", {
    root,
  });
  await ingestContent(
    "Agent reliability requires independent validation.",
    "second.txt",
    { root },
  );
  const provider: LlmProvider = {
    name: "unknown-relationship",
    async complete(request) {
      if (request.purpose === "relationship-analysis") {
        const pairs = JSON.parse(
          request.prompt.slice(request.prompt.lastIndexOf("\n") + 1),
        ) as Array<{ from: string; to: string }>;
        return {
          text: JSON.stringify({
            edges: [
              {
                ...pairs[0],
                type: "supports",
                explanation: "The supplied pair reports matching evidence.",
              },
              {
                from: "claim-" + "f".repeat(32),
                to: pairs[0]?.to,
                type: "supports",
                explanation: "This pair was not supplied.",
              },
            ],
          }),
        };
      }
      return fakeLlm.complete(request);
    },
  };
  const result = await compileWiki({ root, llmProvider: provider });
  const graph = JSON.parse(await readFile(result.claimGraphPath!, "utf8"));
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].type, "supports");
});

test("compile accepts an explicitly excluded source without a summary", async () => {
  const root = await workspace("excluded-source");
  await initWiki(root);
  await ingestContent(
    "This source is outside the configured focus.",
    "outside.txt",
    {
      root,
      title: "Outside source",
    },
  );
  const excluding: LlmProvider = {
    name: "excluding",
    async complete(request) {
      if (request.purpose === "source-analysis") {
        return {
          text: JSON.stringify({
            relevant: false,
            exclusionReason: "The source does not address the research focus.",
            summary: "",
            concepts: [],
            claims: [],
          }),
        };
      }
      if (request.purpose === "synthesis") {
        return {
          text: JSON.stringify({
            concepts: [],
            claims: [],
            contradictions: [],
            gaps: [],
          }),
        };
      }
      return fakeLlm.complete(request);
    },
  };
  const result = await compileWiki({ root, llmProvider: excluding });
  assert.equal(result.concepts, 0);
  const sourceFiles = await readdir(path.join(root, "wiki", "sources"));
  const sourcePage = await readFile(
    path.join(root, "wiki", "sources", sourceFiles[0]!),
    "utf8",
  );
  assert.match(sourcePage, /Excluded from synthesis/);
  assert.match(sourcePage, /Not summarized because this source was excluded/);
});

test("compile repairs one invalid source analysis without weakening quote checks", async () => {
  const root = await workspace("source-analysis-repair");
  await initWiki(root);
  await ingestContent("Exact evidence must remain unchanged.", "exact.txt", {
    root,
  });
  let analysisCalls = 0;
  const repairing: LlmProvider = {
    name: "repairing",
    async complete(request) {
      if (request.purpose === "source-analysis" && analysisCalls++ === 0) {
        return {
          text: JSON.stringify({
            relevant: true,
            exclusionReason: "in scope",
            summary: "Evidence summary.",
            concepts: [
              {
                id: "broken",
                title: "Broken",
                definition: "Broken reference.",
                claimIds: ["missing"],
              },
            ],
            claims: [
              {
                id: "c1",
                text: "Exact evidence.",
                quote: "Exact evidence must remain unchanged.",
              },
            ],
          }),
        };
      }
      return fakeLlm.complete(request);
    },
  };
  await compileWiki({ root, llmProvider: repairing });
  assert.equal(analysisCalls, 2);
});

test("compile repairs one non-JSON source analysis response", async () => {
  const root = await workspace("source-analysis-json-repair");
  await initWiki(root);
  await ingestContent("JSON repair evidence is exact.", "json-repair.txt", {
    root,
  });
  let analysisCalls = 0;
  const repairing: LlmProvider = {
    name: "json-repair",
    async complete(request) {
      if (request.purpose === "source-analysis" && analysisCalls++ === 0) {
        return { text: "This description is not JSON." };
      }
      return fakeLlm.complete(request);
    },
  };
  await compileWiki({ root, llmProvider: repairing });
  assert.equal(analysisCalls, 2);
});

test("single-source compilation projects validated analysis without synthesis", async () => {
  const root = await workspace("single-source-projection");
  await initWiki(root);
  await ingestContent("Single-source evidence is sufficient.", "single.txt", {
    root,
  });
  let synthesisCalls = 0;
  const provider: LlmProvider = {
    name: "single-source",
    async complete(request) {
      if (request.purpose === "synthesis") synthesisCalls++;
      return fakeLlm.complete(request);
    },
  };
  const result = await compileWiki({ root, llmProvider: provider });
  assert.equal(result.concepts, 1);
  assert.equal(synthesisCalls, 0);
  assert.match(
    await readFile(path.join(root, "wiki", "concepts", "evidence.md"), "utf8"),
    /# Evidence/,
  );
  const gapsPath = path.join(root, "meta", "gaps.json");
  await writeFile(
    gapsPath,
    JSON.stringify({
      version: 1,
      gaps: [
        {
          priority: 1,
          description: "Preserved reflection gap",
          searchQuery: "preserved gap",
        },
      ],
    }),
    "utf8",
  );
  await compileWiki({ root, llmProvider: provider });
  assert.match(await readFile(gapsPath, "utf8"), /Preserved reflection gap/);
});

test("compile removes only stale generated pages and renders full provenance", async () => {
  const root = await workspace("stale-generated");
  await initWiki(root);
  await ingestContent("Portable evidence is preserved.", "portable.txt", {
    root,
    title: "Portable evidence",
    mediaType: "text/plain",
    provenanceKind: "url",
    url: "https://example.invalid/portable",
    provider: "test-provider",
    storageUri: "https://storage.invalid/portable.txt",
  });
  const stale = path.join(root, "wiki", "concepts", "stale.md");
  const human = path.join(root, "wiki", "concepts", "human.md");
  await writeFile(
    stale,
    `---
generated: "true"
---
<!-- llmwiki:generated:start -->
# Stale
<!-- llmwiki:generated:end -->
`,
    "utf8",
  );
  await writeFile(human, "# Human-authored research note\n", "utf8");

  await compileWiki({ root, llmProvider: fakeLlm });
  await assert.rejects(() => readFile(stale, "utf8"), /ENOENT/);
  assert.match(await readFile(human, "utf8"), /Human-authored/);
  const sourceFiles = await readdir(path.join(root, "wiki", "sources"));
  const sourcePage = await readFile(
    path.join(root, "wiki", "sources", sourceFiles[0]!),
    "utf8",
  );
  assert.match(sourcePage, /Media type: `text\/plain`/);
  assert.match(sourcePage, /https:\/\/example\.invalid\/portable/);
  assert.match(sourcePage, /test-provider/);
  assert.match(sourcePage, /https:\/\/storage\.invalid\/portable\.txt/);
});

test("query and reflection reject invented compiled references", async () => {
  const root = await workspace("invented-references");
  await initWiki(root);
  await ingestContent("Cited evidence is exact.", "cited.txt", { root });
  await compileWiki({ root, llmProvider: fakeLlm });

  const badQuery: LlmProvider = {
    name: "bad-query",
    async complete(request) {
      if (request.purpose === "query") {
        return {
          text: JSON.stringify({
            answer: "Invented answer.",
            citations: ["unknown-claim"],
          }),
        };
      }
      return fakeLlm.complete(request);
    },
  };
  await assert.rejects(
    () => queryWiki("What is supported?", { root, llmProvider: badQuery }),
    /unknown claim ID/,
  );

  const badReflection: LlmProvider = {
    name: "bad-reflection",
    async complete(request) {
      if (request.purpose === "reflection") {
        return {
          text: JSON.stringify({
            observations: [
              {
                text: "Invented observation.",
                sourceIds: ["unknown-source"],
                claimIds: [],
              },
            ],
            gaps: [],
          }),
        };
      }
      return fakeLlm.complete(request);
    },
  };
  await assert.rejects(
    () => reflectWiki({ root, llmProvider: badReflection }),
    /unknown source or claim ID/,
  );
});

test("provider config migrates legacy settings and validates the registry", () => {
  const legacy = validateConfig({
    wikiPath: "wiki",
    sourcesPath: "sources",
    rawPath: "raw",
    autoCommit: false,
    search: { provider: "crossref", resultLimit: 5 },
    llm: {
      model: "claude-opus-4-8",
      sourceInputChars: 24_000,
      analysisOutputTokens: 8_000,
      synthesisOutputTokens: 12_000,
      reflectionOutputTokens: 6_000,
      queryOutputTokens: 4_000,
      thinking: { type: "adaptive", effort: "high" },
    },
    researchFocus: "evidence",
  });
  assert.deepEqual(legacy.search.providers, ["crossref"]);
  assert.deepEqual(searchProviderRegistry.names().sort(), [
    "arxiv",
    "crossref",
    "openalex",
  ]);
});

test("provider records merge by normalized DOI and retain rich metadata", () => {
  const merged = mergeSearchResults([
    {
      id: "first",
      title: "An Evidence Study",
      url: "https://doi.org/10.1000/ABC",
      provider: "crossref",
      doi: "https://doi.org/10.1000/ABC",
      abstract: "Short abstract.",
      published: "2024-01-01",
      authors: ["Ada Example"],
    },
    {
      id: "https://openalex.org/W1",
      title: "An evidence study",
      url: "https://openalex.org/W1",
      provider: "openalex",
      doi: "doi:10.1000/abc",
      openAlexId: "https://openalex.org/W1",
      abstract: "A substantially richer abstract with more evidence.",
      citationCount: 12,
      fullTextLocations: [
        {
          url: "https://example.invalid/paper.pdf",
          kind: "pdf",
          openAccess: true,
        },
      ],
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.doi, "10.1000/abc");
  assert.equal(
    merged[0]?.abstract,
    "A substantially richer abstract with more evidence.",
  );
  assert.equal(merged[0]?.citationCount, 12);
  assert.deepEqual(merged[0]?.providers, ["crossref", "openalex"]);
  assert.equal(merged[0]?.fullTextLocations?.length, 1);
});

test("arXiv Atom parsing exposes versioned IDs and enforces injected throttle", async () => {
  resetArxivThrottleForTests();
  let now = 0;
  const waits: number[] = [];
  const provider = new ArxivProvider({
    now: () => now,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
    fetch: async () =>
      new Response(
        `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
          <id>http://arxiv.org/abs/2401.00001v2</id><title> Evidence  Paper </title>
          <summary>Useful evidence.</summary><published>2024-01-02T00:00:00Z</published>
          <author><name>Ada Example</name></author><category term="cs.AI"/>
          <link href="https://arxiv.org/pdf/2401.00001v2" type="application/pdf"/>
        </entry></feed>`,
        { headers: { "content-type": "application/atom+xml" } },
      ),
  });
  const first = await provider.search("evidence", { limit: 1 });
  await provider.search("evidence", { limit: 1 });
  assert.equal(first[0]?.arxivId, "2401.00001");
  assert.equal(first[0]?.versionId, "2401.00001v2");
  assert.equal(first[0]?.fullTextLocations?.[0]?.kind, "pdf");
  assert.ok(
    first[0]?.fullTextLocations?.some(
      (location) =>
        location.kind === "landing" && location.url.includes("/abs/"),
    ),
  );
  assert.deepEqual(waits, [3_000]);
});

test("OpenAlex reconstructs abstracts and retries only retryable responses", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const provider = new OpenAlexProvider({
    apiKey: "test-key",
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
    fetch: async () => {
      attempts++;
      if (attempts === 1)
        return new Response("", {
          status: 429,
          headers: { "retry-after": "1" },
        });
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "https://openalex.org/W1",
              title: "Open evidence",
              doi: "https://doi.org/10.1/test",
              publication_date: "2024-01-01",
              cited_by_count: 7,
              abstract_inverted_index: { evidence: [1], Open: [0] },
              open_access: { is_oa: true, oa_status: "gold" },
              best_oa_location: {
                is_oa: true,
                pdf_url: "https://example.invalid/open.pdf",
                license: "cc-by",
              },
            },
          ],
        }),
        {
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "99",
          },
        },
      );
    },
  });
  const result = await provider.search("evidence", { limit: 1 });
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [1_000]);
  assert.equal(result[0]?.abstract, "Open evidence");
  assert.equal(result[0]?.fullTextLocations?.[0]?.openAccess, true);
  assert.equal(provider.lastDiagnostics.rateLimitRemaining, 99);
});

test("OpenAlex requires a key only when searched and inherits work OA metadata", async () => {
  const missing = new OpenAlexProvider({
    fetch: async () => new Response("{}"),
  });
  await assert.rejects(
    () => missing.search("evidence", { limit: 1 }),
    /requires OPENALEX_API_KEY/,
  );
  const provider = new OpenAlexProvider({
    apiKey: "test-key",
    fetch: async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              id: "https://openalex.org/W2",
              title: "Inherited OA evidence",
              open_access: { is_oa: true, oa_status: "green" },
              best_oa_location: {
                pdf_url: "https://example.invalid/inherited.pdf",
              },
            },
          ],
        }),
      ),
  });
  const result = await provider.search("evidence", { limit: 1 });
  assert.equal(result[0]?.oaStatus, "green");
  assert.equal(result[0]?.fullTextLocations?.[0]?.openAccess, true);
});

test("OpenAlex does not mark every location open when only the work is OA", async () => {
  const provider = new OpenAlexProvider({
    apiKey: "test-key",
    fetch: async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              id: "https://openalex.org/W3",
              title: "Mixed locations",
              open_access: { is_oa: true, oa_status: "hybrid" },
              best_oa_location: {
                pdf_url: "https://example.invalid/open.pdf",
              },
              locations: [
                {
                  is_oa: false,
                  pdf_url: "https://publisher.invalid/closed.pdf",
                },
              ],
            },
          ],
        }),
      ),
  });
  const result = await provider.search("evidence", { limit: 1 });
  const locations = result[0]?.fullTextLocations ?? [];
  assert.equal(
    locations.find((location) => location.url.includes("open.pdf"))?.openAccess,
    true,
  );
  assert.equal(
    locations.find((location) => location.url.includes("closed.pdf"))
      ?.openAccess,
    false,
  );
});

test("arXiv concurrent providers serialize globally before their requests start", async () => {
  resetArxivThrottleForTests();
  let now = 0;
  const starts: number[] = [];
  const sleep = async (milliseconds: number) => {
    now += milliseconds;
  };
  const create = () =>
    new ArxivProvider({
      now: () => now,
      sleep,
      fetch: async () => {
        starts.push(now);
        return new Response("<feed />");
      },
    });
  await Promise.all([
    create().search("first", { limit: 1 }),
    create().search("second", { limit: 1 }),
  ]);
  assert.deepEqual(starts, [0, 3_000]);
});

test("full text acquisition rejects landing pages and non-OA locations", async () => {
  const root = await workspace("full-text-reject");
  await initWiki(root);
  let fetches = 0;
  const base = {
    root,
    fetch: async () => {
      fetches++;
      return new Response("unexpected", {
        headers: { "content-type": "text/plain" },
      });
    },
    oaOnly: true,
    maxFileBytes: 100,
  };
  await assert.rejects(
    () =>
      acquireFullText(
        {
          id: "closed",
          title: "Closed",
          url: "https://example.invalid/closed",
          provider: "offline",
          fullTextLocations: [
            {
              url: "https://example.invalid/closed.pdf",
              kind: "pdf",
              openAccess: false,
            },
          ],
        },
        base,
      ),
    /open-access downloadable/,
  );
  await assert.rejects(
    () =>
      acquireFullText(
        {
          id: "landing",
          title: "Landing",
          url: "https://example.invalid/landing",
          provider: "offline",
          fullTextLocations: [
            {
              url: "https://example.invalid/landing",
              kind: "landing",
              openAccess: true,
            },
          ],
        },
        base,
      ),
    /open-access downloadable/,
  );
  assert.equal(fetches, 0);
});

test("full text blocks private-network URLs and redirects", async () => {
  const root = await workspace("full-text-ssrf");
  await initWiki(root);
  const privateResult: SearchResult = {
    id: "private",
    title: "Private",
    url: "https://example.invalid/private",
    provider: "offline",
    fullTextLocations: [
      {
        url: "http://127.0.0.1/private.pdf",
        kind: "pdf",
        openAccess: true,
      },
    ],
  };
  let fetches = 0;
  await assert.rejects(
    () =>
      acquireFullText(privateResult, {
        root,
        oaOnly: true,
        maxFileBytes: 1000,
        fetch: async () => {
          fetches++;
          return new Response();
        },
      }),
    /No explicitly open-access downloadable/,
  );
  assert.equal(fetches, 0);

  const redirectResult: SearchResult = {
    ...privateResult,
    id: "redirect",
    fullTextLocations: [
      {
        url: "https://example.invalid/public.pdf",
        kind: "pdf",
        openAccess: true,
      },
    ],
  };
  await assert.rejects(
    () =>
      acquireFullText(redirectResult, {
        root,
        oaOnly: true,
        maxFileBytes: 1000,
        fetch: async () => {
          fetches++;
          return new Response("", {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data" },
          });
        },
      }),
    /public HTTP\(S\)/,
  );
  assert.equal(fetches, 1);
});

test("full text ingests HTML and PDF bytes with durable metadata and raw hashes", async () => {
  const root = await workspace("full-text-success");
  await initWiki(root);
  const html = await acquireFullText(
    {
      id: "html-id",
      title: "HTML evidence",
      url: "https://example.invalid/work",
      provider: "offline",
      doi: "10.1/html",
      openAccess: true,
      license: "cc-by",
      sourceProvenance: [{ provider: "offline", id: "html-id" }],
      fullTextLocations: [
        {
          url: "https://example.invalid/article.html",
          kind: "html",
          openAccess: true,
        },
      ],
    },
    {
      root,
      oaOnly: true,
      maxFileBytes: 10_000,
      fetch: async () =>
        new Response(
          `<article>${"HTML full text evidence. ".repeat(60)}</article>`,
          {
            headers: { "content-type": "text/html" },
          },
        ),
    },
  );
  assert.match(html.imported.artifact.content, /HTML full text evidence/);
  assert.equal(html.imported.artifact.literature?.doi, "10.1/html");
  const pdfBytes = await minimalPdf("PDF full text evidence");
  const pdf = await acquireFullText(
    {
      id: "pdf-id",
      title: "PDF evidence",
      url: "https://example.invalid/pdf",
      provider: "offline",
      fullTextLocations: [
        {
          url: "https://example.invalid/article.pdf",
          kind: "pdf",
          openAccess: true,
        },
      ],
    },
    {
      root,
      oaOnly: true,
      maxFileBytes: 100_000,
      fetch: async () =>
        new Response(pdfBytes, {
          headers: { "content-type": "application/pdf" },
        }),
    },
  );
  assert.match(pdf.imported.artifact.content, /PDF full text evidence/);
  const manifest = await loadRawManifest({ root });
  const origin = manifest.entries.find(
    (entry) => entry.sourceId === pdf.imported.artifact.id,
  )?.origins[0];
  assert.equal(origin?.kind, "search");
  assert.equal(origin?.provider, "offline");
  assert.ok(origin?.originalSha256);
  assert.equal(origin?.restoreMode, "download");
  assert.ok(origin?.targetPath);
});

test("full text records the acquisition provider and merges literature metadata", async () => {
  const root = await workspace("full-text-provider-provenance");
  await initWiki(root);
  const result = await acquireFullText(
    {
      id: "merged-id",
      title: "Merged evidence",
      url: "https://doi.org/10.1/merged",
      provider: "crossref",
      providers: ["crossref", "arxiv"],
      doi: "10.1/merged",
      arxivId: "2401.00001",
      sourceProvenance: [
        {
          provider: "crossref",
          id: "10.1/merged",
          url: "https://doi.org/10.1/merged",
        },
      ],
      fullTextLocations: [
        {
          url: "https://arxiv.org/pdf/2401.00001",
          kind: "pdf",
          openAccess: true,
          source: "arxiv",
          priority: "arxiv",
        },
      ],
    },
    {
      root,
      oaOnly: true,
      maxFileBytes: 100_000,
      fetch: async () =>
        new Response(await minimalPdf("Merged provider evidence"), {
          headers: { "content-type": "application/pdf" },
        }),
    },
  );
  assert.equal(result.imported.artifact.provenance.provider, "arxiv");
  assert.equal(result.imported.artifact.literature?.provider, "arxiv");
  assert.deepEqual(result.imported.artifact.literature?.providers, [
    "arxiv",
    "crossref",
  ]);
  const manifest = await loadRawManifest({ root });
  assert.equal(manifest.entries[0]?.origins[0]?.provider, "arxiv");

  const merged = await ingestContent(
    result.imported.artifact.content,
    "https://openalex.org/W3",
    {
      root,
      title: "Merged evidence",
      provenanceKind: "search",
      provider: "openalex",
      literature: {
        id: "https://openalex.org/W3",
        title: "Merged evidence",
        url: "https://openalex.org/W3",
        provider: "openalex",
        providers: ["openalex"],
        openAlexId: "W3",
        sourceProvenance: [
          {
            provider: "openalex",
            id: "W3",
            url: "https://openalex.org/W3",
          },
        ],
      },
    },
  );
  assert.deepEqual(merged.artifact.literature?.providers, [
    "arxiv",
    "crossref",
    "openalex",
  ]);
  assert.equal(merged.artifact.literature?.openAlexId, "W3");
});

test("full text enforces size and content-type safeguards", async () => {
  const root = await workspace("full-text-limits");
  await initWiki(root);
  const result: SearchResult = {
    id: "limit",
    title: "Limit",
    url: "https://example.invalid/limit",
    provider: "offline",
    fullTextLocations: [
      {
        url: "https://example.invalid/limit.txt",
        kind: "text",
        openAccess: true,
      },
    ],
  };
  const options = { root, oaOnly: true, maxFileBytes: 4 };
  await assert.rejects(
    () =>
      acquireFullText(result, {
        ...options,
        fetch: async () =>
          new Response("tiny", {
            headers: { "content-type": "text/plain", "content-length": "5" },
          }),
      }),
    /exceeds maxFileBytes/,
  );
  await assert.rejects(
    () =>
      acquireFullText(result, {
        ...options,
        fetch: async () =>
          new Response("large", { headers: { "content-type": "text/plain" } }),
      }),
    /exceeds maxFileBytes/,
  );
  await assert.rejects(
    () =>
      acquireFullText(result, {
        ...options,
        fetch: async () =>
          new Response("image", { headers: { "content-type": "image/png" } }),
      }),
    /Unsupported full-text content type/,
  );
  await assert.rejects(
    () =>
      acquireFullText(
        {
          ...result,
          fullTextLocations: [
            {
              url: "https://example.invalid/not-really.pdf",
              kind: "pdf",
              openAccess: true,
            },
          ],
        },
        {
          root,
          oaOnly: true,
          maxFileBytes: 1000,
          fetch: async () =>
            new Response("not a pdf", {
              headers: { "content-type": "application/pdf" },
            }),
        },
      ),
    /valid PDF signature/,
  );
  await assert.rejects(
    () =>
      acquireFullText(
        {
          ...result,
          fullTextLocations: [
            {
              url: "https://example.invalid/challenge.html",
              kind: "html",
              openAccess: true,
            },
          ],
        },
        {
          root,
          oaOnly: true,
          maxFileBytes: 10_000,
          fetch: async () =>
            new Response(
              "<html><body>Client Challenge. JavaScript is disabled in your browser. Please enable JavaScript to proceed.</body></html>",
              { headers: { "content-type": "text/html" } },
            ),
        },
      ),
    /challenge page/,
  );
});

test("search full-text honors download limits and explicit fallback policy", async () => {
  const root = await workspace("full-text-fallback");
  await initWiki(root);
  const provider: SearchProvider = {
    name: "offline",
    async search() {
      return ["one", "two"].map((id) => ({
        id,
        title: id,
        url: `https://example.invalid/${id}`,
        abstract: "Screening evidence.",
        provider: "offline",
        fullTextLocations: [
          {
            url: `https://example.invalid/${id}.txt`,
            kind: "text" as const,
            openAccess: true,
          },
        ],
      }));
    },
  };
  let fetches = 0;
  const limited = await searchWiki("evidence", {
    root,
    provider,
    importResults: true,
    fullText: true,
    maxDownloads: 1,
    llmProvider: fakeLlm,
    fetch: async () => {
      fetches++;
      return new Response("Full-text evidence.", {
        headers: { "content-type": "text/plain" },
      });
    },
  });
  assert.equal(fetches, 1);
  assert.equal(limited.imported.length, 2);
  assert.ok(
    limited.imported.some(
      (entry) =>
        entry.artifact.mediaType ===
        "application/vnd.llmwiki.search-result+text",
    ),
  );
  assert.match(limited.errors.join("\n"), /maxDownloads/);

  const fallback = await searchWiki("fallback", {
    root,
    provider: {
      ...provider,
      search: async () => (await provider.search(""))?.slice(0, 1),
    },
    importResults: true,
    fullText: true,
    llmProvider: fakeLlm,
    fetch: async () =>
      new Response("nope", { headers: { "content-type": "image/png" } }),
  });
  assert.equal(fallback.imported.length, 1);
  assert.equal(
    fallback.imported[0]?.artifact.mediaType,
    "application/vnd.llmwiki.search-result+text",
  );
  const skipped = await searchWiki("skip", {
    root,
    provider: {
      ...provider,
      search: async () => (await provider.search(""))?.slice(0, 1),
    },
    importResults: true,
    fullText: true,
    onFullTextFailure: "skip",
    llmProvider: fakeLlm,
    fetch: async () =>
      new Response("nope", { headers: { "content-type": "image/png" } }),
  });
  assert.equal(skipped.imported.length, 0);

  const existing = await ingestContent(
    "Existing metadata evidence.",
    "existing.txt",
    {
      root,
      title: "Upgradeable study",
      literature: {
        id: "upgrade",
        title: "Upgradeable study",
        url: "https://example.invalid/upgrade",
        provider: "offline",
        doi: "10.1000/upgrade",
      },
    },
  );
  let upgradeFetches = 0;
  const duplicateLlm: LlmProvider = {
    name: "duplicate-upgrade",
    async complete(request) {
      if (request.purpose === "screening") {
        return {
          text: JSON.stringify({
            relevant: true,
            duplicate: true,
            reason: "Known work with a newly requested full text.",
          }),
        };
      }
      return fakeLlm.complete(request);
    },
  };
  const upgraded = await searchWiki("upgrade", {
    root,
    provider: {
      name: "offline-upgrade",
      async search() {
        return [
          {
            id: "upgrade",
            title: "Upgradeable study",
            url: "https://example.invalid/upgrade",
            abstract: "Existing metadata evidence.",
            provider: "offline",
            doi: "10.1000/upgrade",
            fullTextLocations: [
              {
                url: "https://example.invalid/upgrade.txt",
                kind: "text",
                openAccess: true,
              },
            ],
          },
        ];
      },
    },
    importResults: true,
    fullText: true,
    upgradeSourceIds: [existing.artifact.id],
    llmProvider: duplicateLlm,
    fetch: async () => {
      upgradeFetches++;
      return new Response("Upgraded full-text evidence.", {
        headers: { "content-type": "text/plain" },
      });
    },
  });
  assert.equal(upgradeFetches, 1);
  assert.equal(upgraded.imported.length, 1);
  assert.equal(upgraded.imported[0]?.artifact.mediaType, "text/plain");
});

test("search normalizes year bounds and limits merged provider output", async () => {
  const root = await workspace("search-date-limit");
  await initWiki(root);
  let requestedLimit = 0;
  const provider: SearchProvider = {
    name: "offline",
    async search(_query, options) {
      requestedLimit = options.limit;
      return [
        {
          id: "year",
          title: "Year-only",
          url: "https://example.invalid/year",
          provider: "offline",
          published: "2024",
        },
        {
          id: "date",
          title: "Dated",
          url: "https://example.invalid/date",
          provider: "offline",
          published: "2024-12-31",
        },
      ];
    },
  };
  const result = await searchWiki("dates", {
    root,
    provider,
    limit: 1,
    from: "2024-12-15",
    to: "2024-12-31",
  });
  assert.equal(requestedLimit, 2);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.id, "year");
});
