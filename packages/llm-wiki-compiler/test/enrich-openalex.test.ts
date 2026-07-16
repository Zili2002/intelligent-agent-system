import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  enrichOpenAlex,
  extractLegacyLiterature,
  ingestContent,
  initWiki,
  OpenAlexProvider,
  refreshKnowledge,
  scoreSource,
  type OpenAlexLookupProvider,
  type SearchProvider,
  type SearchResult,
} from "../src/index.js";

const root = path.resolve("test", ".openalex-enrich-work");
let serial = 0;

async function workspace(): Promise<string> {
  const target = path.join(root, String(++serial));
  await mkdir(target, { recursive: true });
  await initWiki(target);
  return target;
}

function work(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "https://openalex.org/W123",
    title: "Exact Metadata Study",
    url: "https://doi.org/10.1000/exact",
    provider: "openalex",
    openAlexId: "https://openalex.org/W123",
    doi: "10.1000/exact",
    authors: ["Ada Example"],
    published: "2024-02-03",
    year: 2024,
    citationCount: 17,
    openAccess: true,
    license: "cc-by",
    workType: "article",
    isRetracted: false,
    sourceProvenance: [
      {
        provider: "openalex",
        id: "https://openalex.org/W123",
        url: "https://doi.org/10.1000/exact",
      },
    ],
    ...overrides,
  };
}

function provider(
  values: SearchResult[] = [work()],
  byId: SearchResult | undefined = undefined,
  byDoi: SearchResult | undefined = undefined,
): OpenAlexLookupProvider {
  return {
    name: "openalex",
    async search() {
      return values;
    },
    async lookupByOpenAlexId() {
      return byId;
    },
    async lookupByDoi() {
      return byDoi;
    },
  };
}

before(async () => {
  await rm(root, { recursive: true, force: true });
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("OpenAlex enrichment matches exact IDs and preserves source evidence", async () => {
  const target = await workspace();
  const ingested = await ingestContent("Immutable evidence.", "evidence.txt", {
    root: target,
    title: "Exact Metadata Study",
    literature: {
      id: "old",
      title: "Exact Metadata Study",
      url: "https://example.test",
      provider: "crossref",
      openAlexId: "W123",
      arxivId: "2501.00001",
      citationCount: 4,
      sourceProvenance: [{ provider: "crossref", id: "old" }],
    },
  });
  const original = await readFile(ingested.path, "utf8");
  const result = await enrichOpenAlex({
    root: target,
    openAlexProvider: provider([], work()),
  });
  const updated = JSON.parse(await readFile(ingested.path, "utf8"));
  assert.equal(result.matchedByOpenAlexId, 1);
  assert.equal(result.enriched, 1);
  assert.equal(updated.content, JSON.parse(original).content);
  assert.equal(updated.hash, JSON.parse(original).hash);
  assert.equal(updated.literature.citationCount, 17);
  assert.deepEqual(updated.literature.providers, ["crossref", "openalex"]);
  assert.equal(updated.literature.sourceProvenance.length, 2);
  assert.equal(
    (
      await enrichOpenAlex({
        root: target,
        openAlexProvider: provider([], work()),
      })
    ).unchanged,
    1,
  );
});

test("knowledge refresh propagates versions and retractions without repeated work", async () => {
  const target = await workspace();
  const ingested = await ingestContent("Lifecycle evidence.", "lifecycle.txt", {
    root: target,
    title: "Exact Metadata Study",
    literature: {
      id: "old",
      title: "Exact Metadata Study",
      url: "https://example.test",
      provider: "openalex",
      openAlexId: "W123",
      arxivId: "2501.00001",
      versionId: "2501.00001v1",
      isRetracted: false,
    },
  });
  await writeFile(
    path.join(target, "meta", "claims.json"),
    JSON.stringify({
      claims: [
        {
          id: "claim-lifecycle",
          sourceId: ingested.artifact.id,
          statement: "Lifecycle evidence.",
          quote: "Lifecycle evidence.",
        },
      ],
    }),
  );
  let lookups = 0;
  const refreshedProvider: OpenAlexLookupProvider = {
    ...provider(),
    async lookupByOpenAlexId() {
      lookups++;
      return work({ versionId: "2501.00001v2", isRetracted: true });
    },
  };
  const arxivProvider: SearchProvider = {
    name: "arxiv",
    async search() {
      return [
        {
          id: "2501.00001v2",
          title: "Exact Metadata Study",
          url: "https://arxiv.org/abs/2501.00001v2",
          provider: "arxiv",
          arxivId: "2501.00001",
          versionId: "2501.00001v2",
        },
      ];
    },
  };
  const start = new Date("2026-07-15T00:00:00.000Z");
  const refreshed = await refreshKnowledge({
    root: target,
    force: true,
    recompute: false,
    openAlexProvider: refreshedProvider,
    arxivProvider,
    now: () => start,
  });
  assert.equal(refreshed.metadataChanged, true);
  assert.deepEqual(refreshed.versionChangedSourceIds, [ingested.artifact.id]);
  assert.equal(refreshed.retracted, 1);
  assert.equal(refreshed.frontier.pending, 1);
  assert.equal(
    JSON.parse(await readFile(ingested.path, "utf8")).literature.versionId,
    "2501.00001v1",
  );
  const lifecycle = JSON.parse(
    await readFile(
      path.join(target, "meta", "knowledge_lifecycle.json"),
      "utf8",
    ),
  );
  assert.equal(lifecycle.claims[0].status, "retracted-source");

  const skipped = await refreshKnowledge({
    root: target,
    recompute: false,
    openAlexProvider: refreshedProvider,
    arxivProvider,
    now: () => new Date(start.getTime() + 60 * 60_000),
  });
  assert.equal(skipped.skipped, true);
  assert.equal(lookups, 1);

  const unchanged = await refreshKnowledge({
    root: target,
    recompute: false,
    openAlexProvider: refreshedProvider,
    arxivProvider,
    now: () => new Date(start.getTime() + 25 * 60 * 60_000),
  });
  assert.equal(unchanged.metadataChanged, false);
  assert.equal(unchanged.compiled, false);
  assert.equal(unchanged.indexed, false);
});

test("OpenAlex enrichment deterministically extracts legacy DOI and dry runs", async () => {
  const target = await workspace();
  const ingested = await ingestContent(
    "# Exact Metadata Study\n\nURL: https://doi.org/10.1000/exact\n\nDOI: 10.1000/exact\n\nAuthors: Ada Example\n\nPublished: 2024-02-03\n\nAbstract:\nLegacy record.",
    "legacy.txt",
    { root: target },
  );
  const original = await readFile(ingested.path, "utf8");
  const artifact = JSON.parse(original);
  assert.deepEqual(extractLegacyLiterature(artifact), {
    title: "Exact Metadata Study",
    doi: "10.1000/exact",
    authors: ["Ada Example"],
    published: "2024-02-03",
    year: 2024,
    url: "https://doi.org/10.1000/exact",
  });
  const dry = await enrichOpenAlex({
    root: target,
    dryRun: true,
    openAlexProvider: provider([], undefined, work()),
  });
  assert.equal(dry.matchedByDoi, 1);
  assert.equal(await readFile(ingested.path, "utf8"), original);
  const written = await enrichOpenAlex({
    root: target,
    openAlexProvider: provider([], undefined, work()),
  });
  assert.equal(written.enriched, 1);
});

test("OpenAlex title fallback requires one compatible exact candidate", async () => {
  const target = await workspace();
  await ingestContent("Evidence.", "title.txt", {
    root: target,
    title: "Exact Metadata Study",
    literature: {
      id: "legacy",
      title: "Exact Metadata Study",
      url: "https://example.test",
      provider: "crossref",
      authors: ["Ada Example"],
      year: 2024,
    },
  });
  const result = await enrichOpenAlex({
    root: target,
    openAlexProvider: provider([
      work({ title: "Exact Metadata Study", year: 2024 }),
      work({ id: "W999", openAlexId: "W999", year: 2023 }),
    ]),
  });
  assert.equal(result.matchedByTitle, 1);

  const ambiguousRoot = await workspace();
  await ingestContent("Evidence.", "ambiguous.txt", {
    root: ambiguousRoot,
    title: "Exact Metadata Study",
  });
  const ambiguous = await enrichOpenAlex({
    root: ambiguousRoot,
    openAlexProvider: provider([
      work(),
      work({ id: "W124", openAlexId: "W124" }),
    ]),
  });
  assert.equal(ambiguous.ambiguous, 1);
  assert.equal(ambiguous.enriched, 0);

  const mismatchRoot = await workspace();
  await ingestContent("Evidence.", "mismatch.txt", {
    root: mismatchRoot,
    title: "Exact Metadata Study",
    literature: {
      id: "legacy",
      title: "Exact Metadata Study",
      url: "https://example.test",
      provider: "crossref",
      authors: ["Ada Example"],
      year: 2024,
    },
  });
  const mismatch = await enrichOpenAlex({
    root: mismatchRoot,
    openAlexProvider: provider([
      work({ year: 2023, authors: ["Other Author"] }),
    ]),
  });
  assert.equal(mismatch.ambiguous, 1);
  assert.equal(mismatch.enriched, 0);
});

test("explicitly retracted work receives a severe deterministic quality cap", () => {
  const score = scoreSource({
    version: 1,
    id: "a".repeat(64),
    hash: "a".repeat(64),
    title: "Retracted",
    mediaType: "text/plain",
    content: "Evidence",
    provenance: { kind: "search", input: "x" },
    provenanceHistory: [{ kind: "search", input: "x" }],
    ingestedAt: "2026-01-01T00:00:00.000Z",
    literature: {
      id: "W1",
      title: "Retracted",
      url: "https://openalex.org/W1",
      provider: "openalex",
      isRetracted: true,
      citationCount: 1_000_000,
    },
  });
  assert.ok(score.score <= 15);
  assert.ok(score.penalties.some((item) => item.includes("retraction")));
});

test("enrichment reports a missing OpenAlex key without revealing a value", async () => {
  const target = await workspace();
  await ingestContent("Evidence.", "key.txt", { root: target });
  await assert.rejects(
    () =>
      enrichOpenAlex({
        root: target,
        openAlexProvider: new OpenAlexProvider({
          apiKey: "",
          fetch: async () => new Response("{}"),
        }),
      }),
    (error: Error) =>
      /OPENALEX_API_KEY/.test(error.message) &&
      !/secret-value/.test(error.message),
  );
});
