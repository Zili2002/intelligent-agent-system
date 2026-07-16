import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  buildSemanticIndex,
  createRetrievalBenchmark,
  evaluateRetrieval,
  initWiki,
  type EmbeddingProvider,
  type LlmProvider,
} from "../src/index.js";

const roots: string[] = [];

after(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

const embeddings: EmbeddingProvider = {
  model: "fake-eval-embeddings",
  async embed(texts) {
    return texts.map((text) => {
      const lower = text.toLowerCase();
      const vector = [
        lower.includes("recover") ||
        lower.includes("restore") ||
        lower.includes("failure")
          ? 1
          : 0,
        lower.includes("plan") || lower.includes("deliberat") ? 1 : 0,
      ];
      const norm = Math.hypot(...vector) || 1;
      return vector.map((value) => value / norm);
    });
  },
};

test("retrieval benchmark measures recall, citations, refusal, and contradictions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-eval-"));
  roots.push(root);
  await initWiki(root);
  const configPath = path.join(root, ".llmwiki-config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.retrieval.embeddingModel = embeddings.model;
  await writeFile(configPath, JSON.stringify(config));
  const recoveryId = "claim-recovery";
  const planningId = "claim-planning";
  const claims = [
    {
      id: recoveryId,
      sourceId: "source-recovery",
      statement: "Failure recovery uses bounded rollback.",
      quote: "bounded rollback",
      sourceTitle: "Recovery study",
      topicIds: ["recovery-resilience"],
      confidence: 80,
      evidenceStatus: "corroborated",
      status: "accepted",
    },
    {
      id: planningId,
      sourceId: "source-planning",
      statement: "Long planning can reduce task accuracy.",
      quote: "reduce task accuracy",
      sourceTitle: "Planning study",
      topicIds: ["planning-reasoning"],
      confidence: 75,
      evidenceStatus: "contested",
      status: "accepted",
    },
  ];
  await writeFile(
    path.join(root, "meta", "claims.json"),
    JSON.stringify({ claims, sources: [] }),
  );
  await writeFile(
    path.join(root, "meta", "knowledge_graph.json"),
    JSON.stringify({
      claims: claims.map((claim) => ({ ...claim, text: claim.statement })),
    }),
  );
  await writeFile(
    path.join(root, "meta", "claim_graph.json"),
    JSON.stringify({
      edges: [
        {
          from: recoveryId,
          to: planningId,
          type: "contradicts",
          explanation: "The studies report different reliability effects.",
        },
      ],
    }),
  );
  await writeFile(
    path.join(root, "meta", "contradiction_adjudications.json"),
    JSON.stringify({
      adjudications: [
        {
          from: recoveryId,
          to: planningId,
          resolution: "context-dependent",
          rationale: "The mechanisms differ.",
          evidenceClaimIds: [recoveryId, planningId],
          evidenceNeeds: [],
        },
      ],
    }),
  );
  await buildSemanticIndex({ root, embeddingProvider: embeddings });
  const llm: LlmProvider = {
    name: "evaluation",
    async complete(request) {
      if (request.purpose === "retrieval-benchmark") {
        return {
          text: JSON.stringify({
            cases: [
              {
                id: "recovery",
                kind: "claim",
                question: "How can operation be restored after a failure?",
                expectedClaimIds: [recoveryId],
              },
              {
                id: "planning",
                kind: "claim",
                question: "Can extended deliberation hurt task results?",
                expectedClaimIds: [planningId],
              },
              {
                id: "tradeoff",
                kind: "contradiction",
                question:
                  "How do recovery structure and extended planning differ in reliability impact?",
                expectedClaimIds: [recoveryId, planningId],
              },
              {
                id: "geology",
                kind: "no-evidence",
                question: "How is basaltic ocean crust formed?",
                expectedClaimIds: [],
              },
              {
                id: "biology",
                kind: "no-evidence",
                question: "How do emperor penguins breed?",
                expectedClaimIds: [],
              },
            ],
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
            answer: "Evidence-grounded answer.",
            citations: request.prompt.includes(
              "How do recovery structure and extended planning differ",
            )
              ? [recoveryId]
              : candidates.map((candidate) => candidate.id),
          }),
        };
      }
      throw new Error(`Unexpected LLM purpose: ${request.purpose}`);
    },
  };
  const benchmark = await createRetrievalBenchmark({
    root,
    llmProvider: llm,
  });
  assert.equal(benchmark.cases.length, 5);
  const evaluation = await evaluateRetrieval({
    root,
    llmProvider: llm,
    embeddingProvider: embeddings,
    answer: true,
    maxLlmTokens: 100_000,
  });
  assert.equal(evaluation.recallAt10, 1);
  assert.equal(evaluation.citationRecall, 1);
  assert.equal(evaluation.citationValidity, 1);
  assert.equal(evaluation.refusalAccuracy, 1);
  assert.equal(evaluation.contradictionRetrievalCoverage, 1);
  assert.equal(evaluation.contradictionCitationCoverage, 1);
});
