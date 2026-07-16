import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  buildSemanticIndex,
  initWiki,
  loadSemanticIndex,
  retrieveClaims,
  semanticSimilarity,
  type EmbeddingProvider,
} from "../src/index.js";

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-semantic-"));
  roots.push(root);
  await initWiki(root);
  return root;
}

after(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

const embeddingProvider: EmbeddingProvider = {
  model: "fake-semantic-v1",
  async embed(texts) {
    return texts.map((text) => {
      const lower = text.toLowerCase();
      const vector = [
        lower.includes("planning") ? 1 : 0,
        lower.includes("recovery") ||
        lower.includes("restore") ||
        lower.includes("breakdown")
          ? 1
          : 0,
        lower.includes("evaluation") ? 1 : 0,
      ];
      const norm = Math.hypot(...vector) || 1;
      return vector.map((value) => value / norm);
    });
  },
};

function claim(id: string, statement: string) {
  return {
    id,
    sourceId: `source-${id}`,
    statement,
    quote: statement,
    sourceTitle: `Source ${id}`,
    topicIds: ["evaluation-reliability"],
  };
}

test("semantic indexing incrementally embeds changed Claims and removes stale entries", async () => {
  const root = await workspace();
  const claimsPath = path.join(root, "meta", "claims.json");
  const firstClaims = [
    claim("claim-a", "Planning improves reliability."),
    claim("claim-b", "Recovery requires evaluation."),
  ];
  await writeFile(claimsPath, JSON.stringify({ claims: firstClaims }));
  const first = await buildSemanticIndex({ root, embeddingProvider });
  assert.equal(first.embedded, 2);
  assert.equal(first.reused, 0);
  assert.equal(first.dimensions, 3);

  const second = await buildSemanticIndex({ root, embeddingProvider });
  assert.equal(second.embedded, 0);
  assert.equal(second.reused, 2);

  await writeFile(
    claimsPath,
    JSON.stringify({
      claims: [
        firstClaims[0],
        claim("claim-b", "Recovery requires planning evaluation."),
      ],
    }),
  );
  const changed = await buildSemanticIndex({ root, embeddingProvider });
  assert.equal(changed.embedded, 1);
  assert.equal(changed.reused, 1);

  await writeFile(claimsPath, JSON.stringify({ claims: [firstClaims[0]] }));
  const removed = await buildSemanticIndex({ root, embeddingProvider });
  assert.equal(removed.removed, 1);
  const artifact = await loadSemanticIndex(path.join(root, "meta"));
  assert.equal(artifact?.claims.length, 1);
  const persisted = await readFile(removed.path, "utf8");
  assert.doesNotThrow(() => JSON.parse(persisted));
});

test("quantized semantic similarity preserves normalized ordering", () => {
  assert.ok(semanticSimilarity([1, 0, 0], [127, 0, 0]) > 0.99);
  assert.ok(semanticSimilarity([1, 0, 0], [0, 127, 0]) < 0.01);
});

test("hybrid retrieval recalls semantic paraphrases and expands graph neighbors", async () => {
  const root = await workspace();
  const configPath = path.join(root, ".llmwiki-config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.retrieval.embeddingModel = embeddingProvider.model;
  await writeFile(configPath, JSON.stringify(config));
  const recovery = {
    ...claim("claim-recovery", "Failure recovery uses rollback."),
    confidence: 80,
    evidenceStatus: "corroborated",
    status: "accepted",
  };
  const neighbor = {
    ...claim("claim-neighbor", "Bounded retries contain cascading faults."),
    confidence: 70,
    evidenceStatus: "corroborated",
    status: "accepted",
  };
  await writeFile(
    path.join(root, "meta", "claims.json"),
    JSON.stringify({ claims: [recovery, neighbor], sources: [] }),
  );
  await writeFile(
    path.join(root, "meta", "claim_graph.json"),
    JSON.stringify({
      edges: [
        {
          from: recovery.id,
          to: neighbor.id,
          type: "supports",
          explanation: "Both describe bounded recovery.",
        },
      ],
    }),
  );
  await buildSemanticIndex({ root, embeddingProvider });
  const result = await retrieveClaims(
    "How can a system restore operation after a breakdown?",
    { root, embeddingProvider },
  );
  assert.equal(result.mode, "hybrid");
  assert.equal(result.candidates[0]?.claim.id, recovery.id);
  assert.equal(result.candidates[0]?.lexicalScore, 0);
  assert.ok((result.candidates[0]?.semanticScore ?? 0) > 0.7);
  assert.ok(
    result.candidates.some(
      (candidate) =>
        candidate.claim.id === neighbor.id && candidate.graphScore === 1,
    ),
  );
});

test("retrieval remains lexical when no semantic index exists", async () => {
  const root = await workspace();
  const planning = {
    ...claim("claim-planning", "Planning improves reliability."),
    confidence: 70,
    evidenceStatus: "corroborated",
    status: "accepted",
  };
  await writeFile(
    path.join(root, "meta", "claims.json"),
    JSON.stringify({ claims: [planning], sources: [] }),
  );
  const result = await retrieveClaims("How does planning help?", { root });
  assert.equal(result.mode, "lexical");
  assert.equal(result.candidates[0]?.claim.id, planning.id);
});

test("retrieval excludes retracted sources unless retraction is the question", async () => {
  const root = await workspace();
  const withdrawn = {
    ...claim("claim-withdrawn", "Planning improves reliability."),
    confidence: 80,
    evidenceStatus: "corroborated",
    status: "accepted",
  };
  await writeFile(
    path.join(root, "meta", "claims.json"),
    JSON.stringify({ claims: [withdrawn], sources: [] }),
  );
  await writeFile(
    path.join(root, "meta", "knowledge_lifecycle.json"),
    JSON.stringify({
      claims: [
        {
          claimId: withdrawn.id,
          sourceId: withdrawn.sourceId,
          status: "retracted-source",
        },
      ],
    }),
  );
  const normal = await retrieveClaims("Does planning improve reliability?", {
    root,
  });
  assert.equal(normal.candidates.length, 0);
  const retraction = await retrieveClaims(
    "Was planning reliability evidence retracted?",
    { root },
  );
  assert.equal(retraction.candidates[0]?.claim.id, withdrawn.id);
});

test("embedding profiles use passage/query roles and alternate indexes remain isolated", async () => {
  const root = await workspace();
  const configPath = path.join(root, ".llmwiki-config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.retrieval.embeddingModel = "profile-model";
  config.retrieval.embeddingDtype = "q8";
  config.retrieval.queryPrefix = "query: ";
  config.retrieval.passagePrefix = "passage: ";
  await writeFile(configPath, JSON.stringify(config));
  const planning = {
    ...claim("claim-profile", "Planning improves reliability."),
    confidence: 70,
    evidenceStatus: "corroborated",
    status: "accepted",
  };
  await writeFile(
    path.join(root, "meta", "claims.json"),
    JSON.stringify({ claims: [planning], sources: [] }),
  );
  const roles: string[] = [];
  const profileProvider: EmbeddingProvider = {
    model: "profile-model",
    configurationId: "profile-model\u0000q8\u0000query: \u0000passage: ",
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
    async embed(texts, role) {
      roles.push(role ?? "passage");
      return texts.map(() => [1, 0]);
    },
  };
  const candidatePath = path.join(root, "meta", "candidates", "profile.json");
  await buildSemanticIndex({
    root,
    embeddingProvider: profileProvider,
    outputPath: candidatePath,
  });
  assert.equal(
    await readFile(
      path.join(root, "meta", "semantic_index.json"),
      "utf8",
    ).catch(() => undefined),
    undefined,
  );
  const result = await retrieveClaims("How does planning help?", {
    root,
    embeddingProvider: profileProvider,
    semanticIndexPath: candidatePath,
  });
  assert.equal(result.candidates[0]?.claim.id, planning.id);
  assert.deepEqual(roles, ["passage", "query"]);
  await assert.rejects(
    () =>
      retrieveClaims("How does planning help?", {
        root,
        embeddingProvider: {
          ...profileProvider,
          configurationId: "different-profile",
        },
        semanticIndexPath: candidatePath,
      }),
    /does not match semantic index/,
  );
});
