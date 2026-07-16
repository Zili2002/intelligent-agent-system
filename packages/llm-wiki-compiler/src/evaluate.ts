import path from "node:path";
import { loadConfig } from "./config.js";
import {
  LlmUsageTracker,
  requestJson,
  requireLlm,
  WikiLlmResponseError,
} from "./llm.js";
import { queryWiki, retrieveClaims } from "./query.js";
import type {
  LlmUsage,
  RetrievalBenchmarkCase,
  RetrievalBenchmarkKind,
  RetrievalBenchmarkResult,
  RetrievalEvaluationResult,
  ServiceOptions,
} from "./types.js";
import { readTextIfExists, writeText } from "./utils.js";

const BENCHMARK_VERSION = 1;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function kind(value: unknown, label: string): RetrievalBenchmarkKind {
  if (
    value !== "claim" &&
    value !== "contradiction" &&
    value !== "no-evidence"
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function benchmarkCases(
  value: unknown,
  knownClaimIds: Set<string>,
  requiredSummaryIds: Set<string>,
): RetrievalBenchmarkCase[] {
  const data = record(value, "retrieval benchmark");
  if (!Array.isArray(data.cases) || data.cases.length > 64) {
    throw new Error("retrieval benchmark cases must be an array");
  }
  const cases = data.cases.map((item, index) => {
    const entry = record(item, `cases[${index}]`);
    if (!Array.isArray(entry.expectedClaimIds)) {
      throw new Error(`cases[${index}].expectedClaimIds must be an array`);
    }
    const expectedClaimIds = entry.expectedClaimIds.map((id, claimIndex) =>
      text(id, `cases[${index}].expectedClaimIds[${claimIndex}]`, 120),
    );
    if (expectedClaimIds.some((id) => !knownClaimIds.has(id))) {
      throw new Error("retrieval benchmark references an unknown Claim");
    }
    const caseKind = kind(entry.kind, `cases[${index}].kind`);
    if (
      (caseKind === "no-evidence" && expectedClaimIds.length) ||
      (caseKind === "claim" && !expectedClaimIds.length) ||
      (caseKind === "contradiction" && expectedClaimIds.length !== 2)
    ) {
      throw new Error("retrieval benchmark expected Claim count is invalid");
    }
    return {
      id: text(entry.id, `cases[${index}].id`, 120),
      kind: caseKind,
      question: text(entry.question, `cases[${index}].question`),
      expectedClaimIds: [...new Set(expectedClaimIds)],
    };
  });
  if (new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new Error("retrieval benchmark case IDs must be unique");
  }
  const coveredSummaryIds = new Set(
    cases
      .filter((item) => item.kind === "claim")
      .flatMap((item) => item.expectedClaimIds),
  );
  if ([...requiredSummaryIds].some((id) => !coveredSummaryIds.has(id))) {
    throw new Error("retrieval benchmark must cover every summary Claim");
  }
  if (cases.filter((item) => item.kind === "no-evidence").length < 2) {
    throw new Error("retrieval benchmark requires two no-evidence cases");
  }
  return cases;
}

async function jsonArtifact(
  file: string,
  label: string,
): Promise<Record<string, unknown>> {
  const content = await readTextIfExists(file);
  if (!content) throw new Error(`${label} is missing: ${file}`);
  return record(JSON.parse(content), label);
}

function addUsage(target: Required<LlmUsage>, usage?: LlmUsage): void {
  target.inputTokens += usage?.inputTokens ?? 0;
  target.outputTokens += usage?.outputTokens ?? 0;
}

function tokenTotal(usage: LlmUsage): number {
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

function remainingTokens(
  maximum: number | undefined,
  used: number,
): number | undefined {
  if (maximum === undefined) return undefined;
  const remaining = maximum - used;
  if (remaining < 1)
    throw new Error("Retrieval evaluation exhausted its budget");
  return remaining;
}

export async function createRetrievalBenchmark(
  options: ServiceOptions & { force?: boolean } = {},
): Promise<RetrievalBenchmarkResult> {
  const config = await loadConfig(options.root);
  const benchmarkPath = path.join(config.metaDir, "retrieval_benchmark.json");
  const [registry, summary, graph] = await Promise.all([
    jsonArtifact(path.join(config.metaDir, "claims.json"), "Claim Registry"),
    jsonArtifact(
      path.join(config.metaDir, "knowledge_graph.json"),
      "knowledge graph",
    ),
    jsonArtifact(path.join(config.metaDir, "claim_graph.json"), "Claim graph"),
  ]);
  if (
    !Array.isArray(registry.claims) ||
    !Array.isArray(summary.claims) ||
    !Array.isArray(graph.edges)
  ) {
    throw new Error("Compiled retrieval artifacts are malformed");
  }
  const knownClaimIds = new Set(
    registry.claims.map((item, index) =>
      text(record(item, `claims[${index}]`).id, `claims[${index}].id`, 120),
    ),
  );
  const summaryClaims = summary.claims.map((item, index) => {
    const claim = record(item, `summary claims[${index}]`);
    return {
      id: text(claim.id, `summary claims[${index}].id`, 120),
      statement: text(
        claim.text ?? claim.statement,
        `summary claims[${index}].statement`,
      ),
      quote: text(claim.quote, `summary claims[${index}].quote`),
    };
  });
  const requiredSummaryIds = new Set(summaryClaims.map((claim) => claim.id));
  const existing = await readTextIfExists(benchmarkPath);
  if (existing && !options.force) {
    const data = record(JSON.parse(existing), "retrieval benchmark");
    return {
      path: benchmarkPath,
      cases: benchmarkCases(data, knownClaimIds, requiredSummaryIds),
      usage: {},
    };
  }
  const contradictions = graph.edges
    .map((item, index) => {
      const edge = record(item, `edges[${index}]`);
      return edge.type === "contradicts" &&
        typeof edge.from === "string" &&
        typeof edge.to === "string"
        ? {
            from: edge.from,
            to: edge.to,
            explanation:
              typeof edge.explanation === "string" ? edge.explanation : "",
          }
        : undefined;
    })
    .filter((item): item is { from: string; to: string; explanation: string } =>
      Boolean(item),
    );
  const provider = requireLlm(config, options);
  const usage = new LlmUsageTracker(options.maxLlmTokens);
  const generated = await requestJson(
    provider,
    {
      purpose: "retrieval-benchmark",
      maxTokens: Math.min(config.llm.synthesisOutputTokens, 8_000),
      prompt: `Create a fixed retrieval benchmark for "${config.researchFocus}". Return JSON {cases:[{id,kind,question,expectedClaimIds}]}. For every supplied summary Claim, create exactly one kind="claim" question that is a semantic paraphrase and avoids copying distinctive phrases from the statement or quote. For every contradiction, create one kind="contradiction" question whose expectedClaimIds are exactly the pair. Add at least two kind="no-evidence" questions that are clearly outside this research corpus and have empty expectedClaimIds. Questions must not contain Claim IDs. Use only supplied Claim IDs.\nSummary Claims: ${JSON.stringify(summaryClaims)}\nContradictions: ${JSON.stringify(contradictions)}`,
    },
    (value) => benchmarkCases(value, knownClaimIds, requiredSummaryIds),
    usage,
  );
  await writeText(
    benchmarkPath,
    JSON.stringify(
      {
        version: BENCHMARK_VERSION,
        researchFocus: config.researchFocus,
        generatedAt: (options.now?.() ?? new Date()).toISOString(),
        cases: generated,
      },
      null,
      2,
    ),
  );
  return { path: benchmarkPath, cases: generated, usage: usage.result() };
}

export async function evaluateRetrieval(
  options: ServiceOptions & {
    answer?: boolean;
    benchmarkPath?: string;
    outputPath?: string;
  } = {},
): Promise<RetrievalEvaluationResult> {
  const config = await loadConfig(options.root);
  const benchmark = await jsonArtifact(
    options.benchmarkPath ??
      path.join(config.metaDir, "retrieval_benchmark.json"),
    "retrieval benchmark",
  );
  const registry = await jsonArtifact(
    path.join(config.metaDir, "claims.json"),
    "Claim Registry",
  );
  if (!Array.isArray(registry.claims)) {
    throw new Error("Compiled retrieval artifacts are malformed");
  }
  const knownClaimIds = new Set(
    registry.claims.map((item, index) =>
      text(record(item, `claims[${index}]`).id, `claims[${index}].id`, 120),
    ),
  );
  const cases = benchmarkCases(benchmark, knownClaimIds, new Set());
  const withAnswers = options.answer ?? true;
  const totalUsage: Required<LlmUsage> = {
    inputTokens: 0,
    outputTokens: 0,
  };
  const details: RetrievalEvaluationResult["details"] = [];
  try {
    for (const benchmarkCase of cases) {
      const started = performance.now();
      let retrievedClaimIds: string[];
      let citations: string[];
      if (withAnswers) {
        const remaining = remainingTokens(
          options.maxLlmTokens,
          tokenTotal(totalUsage),
        );
        const queryOptions: ServiceOptions & { limit: number } = {
          root: config.root,
          limit: 10,
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.now ? { now: options.now } : {}),
          ...(options.approveLlm !== undefined
            ? { approveLlm: options.approveLlm }
            : {}),
          ...(options.llmProvider ? { llmProvider: options.llmProvider } : {}),
          ...(options.embeddingProvider
            ? { embeddingProvider: options.embeddingProvider }
            : {}),
          ...(options.semanticIndexPath
            ? { semanticIndexPath: options.semanticIndexPath }
            : {}),
          ...(remaining === undefined ? {} : { maxLlmTokens: remaining }),
        };
        const result = await queryWiki(benchmarkCase.question, queryOptions);
        retrievedClaimIds = (result.retrievedClaimIds ?? []).slice(0, 10);
        citations = result.citations;
        addUsage(totalUsage, result.usage);
      } else {
        const result = await retrieveClaims(benchmarkCase.question, options);
        retrievedClaimIds = result.candidates
          .slice(0, 10)
          .map((item) => item.claim.id);
        citations = [];
      }
      const expected = new Set(benchmarkCase.expectedClaimIds);
      const retrievalHits = benchmarkCase.expectedClaimIds.filter((id) =>
        retrievedClaimIds.includes(id),
      ).length;
      const citationHits = benchmarkCase.expectedClaimIds.filter((id) =>
        citations.includes(id),
      ).length;
      details.push({
        id: benchmarkCase.id,
        kind: benchmarkCase.kind,
        retrievedClaimIds,
        citations,
        retrievalRecall: expected.size ? retrievalHits / expected.size : 1,
        citationRecall: expected.size ? citationHits / expected.size : 1,
        latencyMs: Math.round(performance.now() - started),
      });
    }
  } catch (error) {
    if (error instanceof WikiLlmResponseError) error.addUsage(totalUsage);
    throw error;
  }
  const expectedDetails = details.filter((item) => item.kind !== "no-evidence");
  const contradictionDetails = details.filter(
    (item) => item.kind === "contradiction",
  );
  const noEvidenceDetails = details.filter(
    (item) => item.kind === "no-evidence",
  );
  const allCitations = details.flatMap((item) => item.citations);
  const average = (values: number[]) =>
    values.length
      ? values.reduce((total, value) => total + value, 0) / values.length
      : 1;
  const result: RetrievalEvaluationResult = {
    path:
      options.outputPath ??
      path.join(config.metaDir, "retrieval_evaluation.json"),
    cases: details.length,
    recallAt10: average(expectedDetails.map((item) => item.retrievalRecall)),
    citationRecall: withAnswers
      ? average(expectedDetails.map((item) => item.citationRecall))
      : 0,
    citationValidity: allCitations.length
      ? allCitations.filter((id) => knownClaimIds.has(id)).length /
        allCitations.length
      : 1,
    refusalAccuracy: average(
      noEvidenceDetails.map((item) => (item.citations.length ? 0 : 1)),
    ),
    contradictionRetrievalCoverage: average(
      contradictionDetails.map((item) => item.retrievalRecall),
    ),
    contradictionCitationCoverage: withAnswers
      ? average(contradictionDetails.map((item) => item.citationRecall))
      : 0,
    averageLatencyMs: average(details.map((item) => item.latencyMs)),
    details,
    usage: totalUsage,
  };
  await writeText(
    result.path,
    JSON.stringify(
      {
        version: 1,
        generatedAt: (options.now?.() ?? new Date()).toISOString(),
        ...result,
      },
      null,
      2,
    ),
  );
  return result;
}
