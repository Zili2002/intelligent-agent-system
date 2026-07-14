import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  autoCommitIfEnabled,
  compileWiki,
  CrossrefProvider,
  ingest,
  ingestContent,
  initWiki,
  learnWiki,
  lintWiki,
  loadConfig,
  loadRawManifest,
  queryWiki,
  reflectWiki,
  restoreRaw,
  searchWiki,
  slugify,
  type SearchProvider,
  type SearchResult,
} from "../src/index.js";

const workRoot = path.resolve("test", ".work");
let sequence = 0;

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
    now: () => new Date("2026-02-03T04:05:06Z"),
  });
  assert.equal(compiled.sources, 1);
  assert.ok(compiled.concepts > 0);
  const query = await queryWiki("How does retrieval return evidence?", {
    root,
  });
  assert.ok(query.matches.length > 0);
  assert.match(query.answer, /\[(sources|wiki)\//);
  const lint = await lintWiki({ root });
  assert.equal(lint.ok, true, JSON.stringify(lint.errors));
  const reflection = await reflectWiki({
    root,
    now: () => new Date("2026-02-04T00:00:00Z"),
  });
  assert.match(
    await readFile(reflection.reflectionPath, "utf8"),
    /heuristics/i,
  );
  assert.match(
    await readFile(path.join(root, "meta", "capability_map.md"), "utf8"),
    /Processed sources: 1/,
  );
  assert.match(
    await readFile(path.join(root, "meta", "evolution_log.md"), "utf8"),
    /reflection observations=/,
  );
});

test("query refuses to invent an answer without evidence", async () => {
  const root = await workspace("no-evidence");
  await initWiki(root);
  await compileWiki({ root });
  const result = await queryWiki("unrepresented quasar taxonomy", { root });
  assert.deepEqual(result.matches, []);
  assert.match(result.answer, /No evidence was found/);
  const stopWordsOnly = await queryWiki("what is the", { root });
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
  await compileWiki({ root });
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
    importResults: true,
    limit: 1,
  });
  assert.equal(search.provider, "deterministic-fake");
  assert.equal(search.imported.length, 1);
  const learned = await learnWiki({
    root,
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
    /provider=deterministic-fake/,
  );
  assert.match(
    await readFile(path.join(root, "meta", "evolution_log.md"), "utf8"),
    /learning selected=/,
  );
  assert.ok(calls.length >= 2);
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
  await compileWiki({ root });
  const lint = await lintWiki({ root });
  assert.equal(lint.ok, true, JSON.stringify(lint.errors));
});

test("learn does not search when the compiler recorded no gaps", async () => {
  const root = await workspace("no-gaps-learn");
  await initWiki(root);
  await compileWiki({ root });
  const provider: SearchProvider = {
    name: "must-not-run",
    async search() {
      throw new Error("search should not run");
    },
  };
  const result = await learnWiki({ root, provider });
  assert.deepEqual(result.selectedGaps, []);
  assert.equal(result.imported, 0);
  assert.equal(result.compiled, false);
});
