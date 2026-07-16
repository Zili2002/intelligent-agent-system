import path from "node:path";
import {
  pipeline,
  type DataType,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { loadConfig } from "./config.js";
import type {
  EmbeddingProvider,
  SemanticIndexResult,
  ServiceOptions,
} from "./types.js";
import { readTextIfExists, sha256, writeText } from "./utils.js";

export const SEMANTIC_INDEX_VERSION = 1;

export interface SemanticIndexEntry {
  claimId: string;
  contentHash: string;
  vector: number[];
}

export interface SemanticIndexArtifact {
  version: 1;
  model: string;
  configurationId?: string;
  queryPrefix?: string;
  passagePrefix?: string;
  dimensions: number;
  generatedAt: string;
  claims: SemanticIndexEntry[];
}

export interface SemanticClaimContent {
  id: string;
  statement: string;
  quote: string;
  sourceTitle: string;
  topicIds: string[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string, maximum = 20_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function embeddingText(
  claim: SemanticClaimContent,
  passagePrefix = "",
): string {
  return [
    `${passagePrefix}${claim.statement}`,
    claim.quote,
    claim.sourceTitle,
    claim.topicIds.join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}

export function semanticContentHash(
  claim: SemanticClaimContent,
  passagePrefix = "",
): string {
  return sha256(embeddingText(claim, passagePrefix));
}

export function quantizeEmbedding(vector: number[]): number[] {
  return vector.map((value) =>
    Math.max(-127, Math.min(127, Math.round(value * 127))),
  );
}

function validateVector(vector: unknown, label: string): number[] {
  if (
    !Array.isArray(vector) ||
    !vector.length ||
    vector.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < -127 ||
        value > 127,
    )
  ) {
    throw new Error(`${label} must be a finite quantized vector`);
  }
  return vector;
}

export function parseSemanticIndex(value: unknown): SemanticIndexArtifact {
  const data = record(value, "semantic index");
  if (data.version !== SEMANTIC_INDEX_VERSION) {
    throw new Error("Unsupported semantic index version");
  }
  const model = requiredText(data.model, "semantic index model", 1_000);
  if (
    typeof data.dimensions !== "number" ||
    !Number.isInteger(data.dimensions) ||
    data.dimensions < 1
  ) {
    throw new Error("semantic index dimensions must be positive");
  }
  if (!Array.isArray(data.claims)) {
    throw new Error("semantic index claims must be an array");
  }
  const claims = data.claims.map((item, index) => {
    const entry = record(item, `semantic index claims[${index}]`);
    const vector = validateVector(
      entry.vector,
      `semantic index claims[${index}].vector`,
    );
    if (vector.length !== data.dimensions) {
      throw new Error("semantic index vector dimensions do not match");
    }
    return {
      claimId: requiredText(
        entry.claimId,
        `semantic index claims[${index}].claimId`,
        120,
      ),
      contentHash: requiredText(
        entry.contentHash,
        `semantic index claims[${index}].contentHash`,
        128,
      ),
      vector,
    };
  });
  if (new Set(claims.map((entry) => entry.claimId)).size !== claims.length) {
    throw new Error("semantic index Claim IDs must be unique");
  }
  return {
    version: SEMANTIC_INDEX_VERSION,
    model,
    ...(typeof data.configurationId === "string"
      ? { configurationId: data.configurationId }
      : {}),
    ...(typeof data.queryPrefix === "string"
      ? { queryPrefix: data.queryPrefix }
      : {}),
    ...(typeof data.passagePrefix === "string"
      ? { passagePrefix: data.passagePrefix }
      : {}),
    dimensions: data.dimensions,
    generatedAt: requiredText(
      data.generatedAt,
      "semantic index generatedAt",
      100,
    ),
    claims,
  };
}

export async function loadSemanticIndex(
  metaDir: string,
  indexPath = path.join(metaDir, "semantic_index.json"),
): Promise<SemanticIndexArtifact | undefined> {
  const content = await readTextIfExists(indexPath);
  return content ? parseSemanticIndex(JSON.parse(content)) : undefined;
}

const pipelineCache = new Map<string, Promise<FeatureExtractionPipeline>>();

export class LocalOnnxEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly configurationId: string;
  readonly queryPrefix: string;
  readonly passagePrefix: string;
  readonly #dtype: DataType;

  constructor(
    model: string,
    options: {
      dtype: DataType;
      queryPrefix?: string;
      passagePrefix?: string;
    },
  ) {
    this.model = model;
    this.#dtype = options.dtype;
    this.queryPrefix = options.queryPrefix ?? "";
    this.passagePrefix = options.passagePrefix ?? "";
    this.configurationId =
      options.dtype === "q4" && !this.queryPrefix && !this.passagePrefix
        ? model
        : [model, options.dtype, this.queryPrefix, this.passagePrefix].join(
            "\u0000",
          );
  }

  async embed(
    texts: string[],
    role: "query" | "passage" = "passage",
  ): Promise<number[][]> {
    if (!texts.length) return [];
    const pipelineKey = `${this.model}\u0000${this.#dtype}`;
    let pending = pipelineCache.get(pipelineKey);
    if (!pending) {
      pending = pipeline("feature-extraction", this.model, {
        dtype: this.#dtype,
        ...(process.env.LLMWIKI_MODEL_CACHE
          ? { cache_dir: process.env.LLMWIKI_MODEL_CACHE }
          : {}),
      });
      pipelineCache.set(pipelineKey, pending);
    }
    const extractor = await pending;
    const prefix = role === "query" ? this.queryPrefix : this.passagePrefix;
    const output = await extractor(
      texts.map((text) => `${prefix}${text}`),
      {
        pooling: "mean",
        normalize: true,
      },
    );
    const values = output.tolist();
    if (
      !Array.isArray(values) ||
      values.length !== texts.length ||
      values.some(
        (vector) =>
          !Array.isArray(vector) ||
          vector.some(
            (value) => typeof value !== "number" || !Number.isFinite(value),
          ),
      )
    ) {
      throw new Error("Local embedding model returned an invalid tensor");
    }
    return values as number[][];
  }
}

export class LocalMiniLmEmbeddingProvider extends LocalOnnxEmbeddingProvider {
  constructor(model = "onnx-community/all-MiniLM-L6-v2-ONNX") {
    super(model, { dtype: "q4" });
  }
}

export function configuredEmbeddingProvider(
  config: Awaited<ReturnType<typeof loadConfig>>,
): LocalOnnxEmbeddingProvider {
  return new LocalOnnxEmbeddingProvider(config.retrieval.embeddingModel, {
    dtype: config.retrieval.embeddingDtype,
    queryPrefix: config.retrieval.queryPrefix,
    passagePrefix: config.retrieval.passagePrefix,
  });
}

async function registryClaims(
  metaDir: string,
): Promise<SemanticClaimContent[]> {
  const content = await readTextIfExists(path.join(metaDir, "claims.json"));
  if (!content) throw new Error("No compiled Claim Registry found");
  const data = record(JSON.parse(content), "Claim Registry");
  if (!Array.isArray(data.claims)) {
    throw new Error("Claim Registry claims must be an array");
  }
  return data.claims.map((item, index) => {
    const claim = record(item, `claims[${index}]`);
    return {
      id: requiredText(claim.id, `claims[${index}].id`, 120),
      statement: requiredText(claim.statement, `claims[${index}].statement`),
      quote: requiredText(claim.quote, `claims[${index}].quote`),
      sourceTitle:
        typeof claim.sourceTitle === "string" ? claim.sourceTitle : "",
      topicIds: Array.isArray(claim.topicIds)
        ? claim.topicIds.map((topic, topicIndex) =>
            requiredText(
              topic,
              `claims[${index}].topicIds[${topicIndex}]`,
              120,
            ),
          )
        : [],
    };
  });
}

export async function buildSemanticIndex(
  options: ServiceOptions & { force?: boolean; outputPath?: string } = {},
): Promise<SemanticIndexResult> {
  const config = await loadConfig(options.root);
  const provider =
    options.embeddingProvider ?? configuredEmbeddingProvider(config);
  const claims = await registryClaims(config.metaDir);
  const indexPath =
    options.outputPath ?? path.join(config.metaDir, "semantic_index.json");
  const existing = options.force
    ? undefined
    : await loadSemanticIndex(config.metaDir, indexPath);
  const configurationId = provider.configurationId ?? provider.model;
  const reusable =
    existing?.model === provider.model &&
    (existing.configurationId ?? existing.model) === configurationId
      ? new Map(existing.claims.map((entry) => [entry.claimId, entry]))
      : new Map<string, SemanticIndexEntry>();
  const entries = new Map<string, SemanticIndexEntry>();
  const pending: Array<{
    claim: SemanticClaimContent;
    content: string;
    contentHash: string;
  }> = [];
  let reused = 0;
  for (const claim of claims) {
    const content = embeddingText(claim);
    const contentHash = semanticContentHash(
      claim,
      provider.passagePrefix ?? config.retrieval.passagePrefix,
    );
    const cached = reusable.get(claim.id);
    if (cached?.contentHash === contentHash) {
      entries.set(claim.id, cached);
      reused++;
    } else {
      pending.push({ claim, content, contentHash });
    }
  }
  let dimensions = existing?.model === provider.model ? existing.dimensions : 0;
  for (
    let index = 0;
    index < pending.length;
    index += config.retrieval.embeddingBatchSize
  ) {
    const batch = pending.slice(
      index,
      index + config.retrieval.embeddingBatchSize,
    );
    const vectors = await provider.embed(
      batch.map((item) => item.content),
      "passage",
    );
    if (vectors.length !== batch.length) {
      throw new Error("Embedding provider returned the wrong vector count");
    }
    for (let vectorIndex = 0; vectorIndex < vectors.length; vectorIndex++) {
      const vector = vectors[vectorIndex]!;
      if (!vector.length || vector.some((value) => !Number.isFinite(value))) {
        throw new Error("Embedding provider returned an invalid vector");
      }
      if (dimensions && vector.length !== dimensions) {
        throw new Error("Embedding dimensions changed during indexing");
      }
      dimensions ||= vector.length;
      const item = batch[vectorIndex]!;
      entries.set(item.claim.id, {
        claimId: item.claim.id,
        contentHash: item.contentHash,
        vector: quantizeEmbedding(vector),
      });
    }
  }
  if (claims.length && !dimensions) {
    throw new Error("Semantic index has no embedding dimensions");
  }
  const artifact: SemanticIndexArtifact = {
    version: SEMANTIC_INDEX_VERSION,
    model: provider.model,
    configurationId,
    queryPrefix: provider.queryPrefix ?? "",
    passagePrefix: provider.passagePrefix ?? "",
    dimensions,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    claims: [...entries.values()].sort((left, right) =>
      left.claimId.localeCompare(right.claimId),
    ),
  };
  await writeText(indexPath, JSON.stringify(artifact));
  return {
    path: indexPath,
    model: provider.model,
    dimensions,
    claims: artifact.claims.length,
    embedded: pending.length,
    reused,
    removed: Math.max(0, reusable.size - reused),
  };
}

export function semanticSimilarity(
  query: number[],
  quantizedVector: number[],
): number {
  if (query.length !== quantizedVector.length) return 0;
  let score = 0;
  for (let index = 0; index < query.length; index++) {
    score += query[index]! * (quantizedVector[index]! / 127);
  }
  return Math.max(-1, Math.min(1, score));
}
