import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedWikiConfig, WikiConfig } from "./types.js";

export const CONFIG_FILE = ".llmwiki-config.json";

export const DEFAULT_CONFIG: WikiConfig = {
  wikiPath: "wiki",
  sourcesPath: "sources",
  rawPath: "raw",
  autoCommit: false,
  search: {
    provider: "crossref",
    providers: ["crossref"],
    resultLimit: 5,
    oaOnly: true,
    maxDownloads: 3,
    maxFileBytes: 100 * 1024 * 1024,
  },
  retrieval: {
    embeddingModel: "onnx-community/all-MiniLM-L6-v2-ONNX",
    embeddingDtype: "q4",
    queryPrefix: "",
    passagePrefix: "",
    embeddingBatchSize: 32,
    semanticWeight: 0.55,
    lexicalWeight: 0.25,
    graphWeight: 0.1,
    confidenceWeight: 0.1,
    semanticCandidateLimit: 64,
  },
  lifecycle: {
    maxFrontierItems: 1_000,
    maxPendingPerTarget: 20,
    maxActivePerProblem: 20,
    maxActivePerTopic: 200,
    maxQueriesPerCycle: 10,
    maxAttempts: 3,
    clueTtlDays: 30,
    baseCooldownMinutes: 60,
    semanticClueDedupThreshold: 0.92,
    highWatermarkPercent: 70,
    criticalWatermarkPercent: 90,
    highWatermarkMinPriority: 70,
    criticalWatermarkMinPriority: 95,
    noNoveltyCircuitBreaker: 3,
    noNoveltyCooldownHours: 168,
    maxTerminalFrontierItems: 200,
    maxFrontierHistoryItems: 10_000,
    refreshIntervalHours: 24,
  },
  llm: {
    model: "claude-opus-4-8",
    sourceInputChars: 24_000,
    chunkInputChars: 12_000,
    chunkOverlapChars: 400,
    maxChunksPerSource: 64,
    analysisOutputTokens: 8_000,
    screeningOutputTokens: 2_000,
    synthesisOutputTokens: 12_000,
    reflectionOutputTokens: 6_000,
    queryOutputTokens: 4_000,
    summaryClaimLimit: 16,
    maxClaimsPerTopicPrompt: 48,
    maxRelationshipCandidates: 256,
    relationshipBatchSize: 16,
    queryCandidateLimit: 16,
    thinking: {
      type: "adaptive",
      effort: "high",
    },
  },
  researchFocus: "evidence-grounded research knowledge",
};

function validateRelativePath(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Config ${key} must be a non-empty string`);
  if (path.isAbsolute(value))
    throw new Error(`Config ${key} must be relative to the repository root`);
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Config ${key} must stay inside the repository root`);
  }
  return normalized;
}

export function validateConfig(input: unknown): WikiConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Wiki config must be a JSON object");
  }
  const data = input as Record<string, unknown>;
  const llmInput = data.llm ?? DEFAULT_CONFIG.llm;
  if (!llmInput || typeof llmInput !== "object" || Array.isArray(llmInput))
    throw new Error("Config llm must be an object");
  const llm = llmInput as Record<string, unknown>;
  const bounded = (key: keyof WikiConfig["llm"], min: number, max: number) => {
    const value = llm[key] ?? DEFAULT_CONFIG.llm[key];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < min ||
      value > max
    )
      throw new Error(
        `Config llm.${key} must be an integer from ${min} to ${max}`,
      );
    return value;
  };
  const model = llm.model;
  if (typeof model !== "string" || !model.trim())
    throw new Error("Config llm.model must be a non-empty string");
  const researchFocus = data.researchFocus ?? "";
  if (typeof researchFocus !== "string")
    throw new Error("Config researchFocus must be a string");
  const search = data.search;
  if (!search || typeof search !== "object" || Array.isArray(search)) {
    throw new Error("Config search must be an object");
  }
  const searchData = search as Record<string, unknown>;
  const validProviders = new Set(["crossref", "arxiv", "openalex"]);
  const legacyProvider = searchData.provider;
  if (
    legacyProvider !== undefined &&
    (typeof legacyProvider !== "string" || !validProviders.has(legacyProvider))
  ) {
    throw new Error(
      "Config search.provider must be crossref, arxiv, or openalex",
    );
  }
  const configuredProviders =
    searchData.providers === undefined
      ? [legacyProvider ?? "crossref"]
      : searchData.providers;
  if (
    !Array.isArray(configuredProviders) ||
    configuredProviders.length === 0 ||
    configuredProviders.some(
      (provider) =>
        typeof provider !== "string" || !validProviders.has(provider),
    )
  ) {
    throw new Error(
      "Config search.providers must be a non-empty array of crossref, arxiv, or openalex",
    );
  }
  if (
    typeof searchData.resultLimit !== "number" ||
    !Number.isInteger(searchData.resultLimit) ||
    searchData.resultLimit < 1 ||
    searchData.resultLimit > 100
  ) {
    throw new Error(
      "Config search.resultLimit must be an integer from 1 to 100",
    );
  }
  if (typeof data.autoCommit !== "boolean")
    throw new Error("Config autoCommit must be a boolean");
  const boundedSearch = (key: "maxDownloads" | "maxFileBytes") => {
    const value = searchData[key] ?? DEFAULT_CONFIG.search[key];
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new Error(`Config search.${key} must be a positive integer`);
    }
    return value as number;
  };
  const oaOnly = searchData.oaOnly ?? DEFAULT_CONFIG.search.oaOnly;
  if (typeof oaOnly !== "boolean")
    throw new Error("Config search.oaOnly must be a boolean");
  const retrievalInput = data.retrieval ?? DEFAULT_CONFIG.retrieval;
  if (
    !retrievalInput ||
    typeof retrievalInput !== "object" ||
    Array.isArray(retrievalInput)
  ) {
    throw new Error("Config retrieval must be an object");
  }
  const retrieval = retrievalInput as Record<string, unknown>;
  const embeddingModel =
    retrieval.embeddingModel ?? DEFAULT_CONFIG.retrieval.embeddingModel;
  if (typeof embeddingModel !== "string" || !embeddingModel.trim()) {
    throw new Error("Config retrieval.embeddingModel must be a string");
  }
  const embeddingDtype =
    retrieval.embeddingDtype ?? DEFAULT_CONFIG.retrieval.embeddingDtype;
  if (
    embeddingDtype !== "q4" &&
    embeddingDtype !== "q8" &&
    embeddingDtype !== "fp16" &&
    embeddingDtype !== "fp32"
  ) {
    throw new Error(
      "Config retrieval.embeddingDtype must be q4, q8, fp16, or fp32",
    );
  }
  const retrievalPrefix = (key: "queryPrefix" | "passagePrefix") => {
    const value = retrieval[key] ?? DEFAULT_CONFIG.retrieval[key];
    if (typeof value !== "string" || value.length > 100) {
      throw new Error(`Config retrieval.${key} must be a short string`);
    }
    return value;
  };
  const retrievalInteger = (
    key: "embeddingBatchSize" | "semanticCandidateLimit",
    minimum: number,
    maximum: number,
  ) => {
    const value = retrieval[key] ?? DEFAULT_CONFIG.retrieval[key];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw new Error(
        `Config retrieval.${key} must be an integer from ${minimum} to ${maximum}`,
      );
    }
    return value;
  };
  const retrievalWeight = (
    key:
      | "semanticWeight"
      | "lexicalWeight"
      | "graphWeight"
      | "confidenceWeight",
  ) => {
    const value = retrieval[key] ?? DEFAULT_CONFIG.retrieval[key];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      throw new Error(`Config retrieval.${key} must be from 0 to 1`);
    }
    return value;
  };
  const semanticWeight = retrievalWeight("semanticWeight");
  const lexicalWeight = retrievalWeight("lexicalWeight");
  const graphWeight = retrievalWeight("graphWeight");
  const confidenceWeight = retrievalWeight("confidenceWeight");
  const weightTotal =
    semanticWeight + lexicalWeight + graphWeight + confidenceWeight;
  if (Math.abs(weightTotal - 1) > 0.000_001) {
    throw new Error("Config retrieval weights must sum to 1");
  }
  const lifecycleInput = data.lifecycle ?? DEFAULT_CONFIG.lifecycle;
  if (
    !lifecycleInput ||
    typeof lifecycleInput !== "object" ||
    Array.isArray(lifecycleInput)
  ) {
    throw new Error("Config lifecycle must be an object");
  }
  const lifecycle = lifecycleInput as Record<string, unknown>;
  const lifecycleInteger = (
    key: keyof WikiConfig["lifecycle"],
    minimum: number,
    maximum: number,
  ) => {
    const value = lifecycle[key] ?? DEFAULT_CONFIG.lifecycle[key];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw new Error(
        `Config lifecycle.${key} must be an integer from ${minimum} to ${maximum}`,
      );
    }
    return value;
  };
  const lifecycleRatio = (
    key: "semanticClueDedupThreshold",
    minimum: number,
    maximum: number,
  ) => {
    const value = lifecycle[key] ?? DEFAULT_CONFIG.lifecycle[key];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw new Error(
        `Config lifecycle.${key} must be from ${minimum} to ${maximum}`,
      );
    }
    return value;
  };
  const highWatermarkPercent = lifecycleInteger("highWatermarkPercent", 1, 99);
  const criticalWatermarkPercent = lifecycleInteger(
    "criticalWatermarkPercent",
    2,
    100,
  );
  if (criticalWatermarkPercent <= highWatermarkPercent) {
    throw new Error(
      "Config lifecycle.criticalWatermarkPercent must exceed highWatermarkPercent",
    );
  }
  const chunkInputChars = bounded("chunkInputChars", 32, 20_000);
  const chunkOverlapChars = bounded("chunkOverlapChars", 0, 4_000);
  if (chunkOverlapChars >= chunkInputChars) {
    throw new Error(
      "Config llm.chunkOverlapChars must be smaller than chunkInputChars",
    );
  }
  return {
    wikiPath: validateRelativePath(data.wikiPath, "wikiPath"),
    sourcesPath: validateRelativePath(data.sourcesPath, "sourcesPath"),
    rawPath: validateRelativePath(data.rawPath, "rawPath"),
    autoCommit: data.autoCommit,
    search: {
      ...(legacyProvider
        ? { provider: legacyProvider as "crossref" | "arxiv" | "openalex" }
        : {}),
      providers: [...new Set(configuredProviders)] as Array<
        "crossref" | "arxiv" | "openalex"
      >,
      resultLimit: searchData.resultLimit,
      oaOnly,
      maxDownloads: boundedSearch("maxDownloads"),
      maxFileBytes: boundedSearch("maxFileBytes"),
    },
    retrieval: {
      embeddingModel: embeddingModel.trim(),
      embeddingDtype,
      queryPrefix: retrievalPrefix("queryPrefix"),
      passagePrefix: retrievalPrefix("passagePrefix"),
      embeddingBatchSize: retrievalInteger("embeddingBatchSize", 1, 256),
      semanticWeight,
      lexicalWeight,
      graphWeight,
      confidenceWeight,
      semanticCandidateLimit: retrievalInteger(
        "semanticCandidateLimit",
        1,
        1_000,
      ),
    },
    lifecycle: {
      maxFrontierItems: lifecycleInteger("maxFrontierItems", 10, 100_000),
      maxPendingPerTarget: lifecycleInteger("maxPendingPerTarget", 1, 1_000),
      maxActivePerProblem: lifecycleInteger("maxActivePerProblem", 1, 1_000),
      maxActivePerTopic: lifecycleInteger("maxActivePerTopic", 1, 10_000),
      maxQueriesPerCycle: lifecycleInteger("maxQueriesPerCycle", 1, 1_000),
      maxAttempts: lifecycleInteger("maxAttempts", 1, 20),
      clueTtlDays: lifecycleInteger("clueTtlDays", 1, 3_650),
      baseCooldownMinutes: lifecycleInteger("baseCooldownMinutes", 1, 100_000),
      semanticClueDedupThreshold: lifecycleRatio(
        "semanticClueDedupThreshold",
        0.5,
        1,
      ),
      highWatermarkPercent,
      criticalWatermarkPercent,
      highWatermarkMinPriority: lifecycleInteger(
        "highWatermarkMinPriority",
        0,
        100,
      ),
      criticalWatermarkMinPriority: lifecycleInteger(
        "criticalWatermarkMinPriority",
        0,
        100,
      ),
      noNoveltyCircuitBreaker: lifecycleInteger(
        "noNoveltyCircuitBreaker",
        1,
        100,
      ),
      noNoveltyCooldownHours: lifecycleInteger(
        "noNoveltyCooldownHours",
        1,
        8_760,
      ),
      maxTerminalFrontierItems: lifecycleInteger(
        "maxTerminalFrontierItems",
        0,
        100_000,
      ),
      maxFrontierHistoryItems: lifecycleInteger(
        "maxFrontierHistoryItems",
        10,
        1_000_000,
      ),
      refreshIntervalHours: lifecycleInteger("refreshIntervalHours", 1, 8_760),
    },
    llm: {
      model: model.trim(),
      sourceInputChars: bounded("sourceInputChars", 1_000, 200_000),
      chunkInputChars,
      chunkOverlapChars,
      maxChunksPerSource: bounded("maxChunksPerSource", 1, 1_000),
      analysisOutputTokens: bounded("analysisOutputTokens", 128, 8_000),
      screeningOutputTokens: bounded("screeningOutputTokens", 128, 4_000),
      synthesisOutputTokens: bounded("synthesisOutputTokens", 128, 12_000),
      reflectionOutputTokens: bounded("reflectionOutputTokens", 128, 12_000),
      queryOutputTokens: bounded("queryOutputTokens", 128, 4_000),
      summaryClaimLimit: bounded("summaryClaimLimit", 1, 64),
      maxClaimsPerTopicPrompt: bounded("maxClaimsPerTopicPrompt", 1, 128),
      maxRelationshipCandidates: bounded("maxRelationshipCandidates", 1, 4_096),
      relationshipBatchSize: bounded("relationshipBatchSize", 1, 128),
      queryCandidateLimit: bounded("queryCandidateLimit", 1, 64),
      thinking: (() => {
        const input = llm.thinking ?? DEFAULT_CONFIG.llm.thinking;
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new Error("Config llm.thinking must be an object");
        }
        const thinking = input as Record<string, unknown>;
        if (thinking.type !== "disabled" && thinking.type !== "adaptive") {
          throw new Error(
            'Config llm.thinking.type must be "disabled" or "adaptive"',
          );
        }
        if (
          thinking.effort !== "low" &&
          thinking.effort !== "medium" &&
          thinking.effort !== "high" &&
          thinking.effort !== "xhigh" &&
          thinking.effort !== "max"
        ) {
          throw new Error(
            "Config llm.thinking.effort must be low, medium, high, xhigh, or max",
          );
        }
        return {
          type: thinking.type,
          effort: thinking.effort,
        };
      })(),
    },
    researchFocus: researchFocus.trim(),
  };
}

export async function loadConfig(
  root = process.cwd(),
): Promise<ResolvedWikiConfig> {
  const resolvedRoot = path.resolve(root);
  const configPath = path.join(resolvedRoot, CONFIG_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Wiki config not found: ${configPath}. Run "llmwiki init" first.`,
      );
    }
    if (error instanceof SyntaxError)
      throw new Error(`Malformed JSON in ${configPath}: ${error.message}`);
    throw error;
  }
  const config = validateConfig(parsed);
  return {
    ...config,
    root: resolvedRoot,
    configPath,
    wikiDir: path.resolve(resolvedRoot, config.wikiPath),
    sourcesDir: path.resolve(resolvedRoot, config.sourcesPath),
    rawDir: path.resolve(resolvedRoot, config.rawPath),
    metaDir: path.join(resolvedRoot, "meta"),
    schemaDir: path.join(resolvedRoot, "schema"),
  };
}
