import { randomUUID } from "node:crypto";
import {
  LlmUsageTracker,
  findEvidenceAnchor,
  getSourceArtifact,
  loadConfig,
  requestJson,
  requireLlm,
  type LlmProvider,
  type SourceArtifact,
} from "@intelligent-agent-system/llm-wiki-compiler";
import { buildReviewMaterial } from "./coverage.js";
import { auditSourceCitations } from "./citations.js";
import { evaluateSourceIntegrity } from "./integrity.js";
import type {
  DimensionAssessment,
  EvidenceAnchor,
  PaperPassport,
  PaperReview,
  PaperType,
  ReaderReviewOptions,
  ReadingRecommendation,
  ResolvedReaderConfig,
  ReviewChallenge,
} from "../types.js";

type DimensionName = keyof PaperReview["dimensions"];

interface RawDimension {
  state: DimensionAssessment["state"];
  score?: number;
  confidence: number;
  rationale: string;
  evidenceQuotes: string[];
}

interface RawReview {
  paperType: PaperType;
  dimensions: Record<DimensionName, RawDimension>;
  personalRelevance: number;
  recommendation: Exclude<ReadingRecommendation, "manual-review">;
  estimatedReadMinutes?: number;
  strengths: string[];
  weaknesses: string[];
  criticalIssues: string[];
  prerequisites: string[];
  readingRoute: string[];
}

interface RawFastReview {
  paperType: PaperType;
  personalRelevance: number;
  recommendation: Exclude<ReadingRecommendation, "manual-review">;
  estimatedReadMinutes?: number;
  strengths: string[];
  weaknesses: string[];
  prerequisites: string[];
  readingRoute: string[];
}

export async function reviewPaper(
  config: ResolvedReaderConfig,
  paper: PaperPassport,
  options: ReaderReviewOptions,
): Promise<PaperReview> {
  const provider = await resolveReviewerLlm(config, options);
  const usage = new LlmUsageTracker(
    options.maxLlmTokens ?? config.review.maxTokensPerRun,
  );
  if (options.level === "fast") {
    return fastReview(paper, provider, usage, options.now ?? new Date());
  }
  if (
    config.review.requireFullTextForStandard &&
    paper.acquisition.status !== "available"
  ) {
    throw new Error(
      `${options.level} review requires acquired full text for paper ${paper.id}`,
    );
  }
  const sourceId = paper.acquisition.fullTextSourceId;
  if (!sourceId) {
    throw new Error(`Paper ${paper.id} has no full-text Source ID`);
  }
  const source = await getSourceArtifact(sourceId, { root: config.root });
  if (!source) throw new Error(`Full-text source not found: ${sourceId}`);
  const material = buildReviewMaterial(source, options.level);
  const raw = await requestJson(
    provider,
    {
      purpose: "source-analysis",
      maxTokens: options.level === "standard" ? 6_000 : 8_000,
      prompt: reviewPrompt(paper, source, material.text, options.level),
    },
    parseRawReview,
    usage,
  );
  const review = buildGroundedReview(
    paper,
    source,
    material.coverage,
    raw,
    provider.name,
    usage.result(),
    options.level,
    options.now ?? new Date(),
  );
  review.integrityIssues = evaluateSourceIntegrity(source);
  if (options.auditCitations) {
    const audits = await auditSourceCitations(source, {
      root: config.root,
      ...(options.approveNetwork === true ? { approveNetwork: true } : {}),
      ...(options.citationProviders
        ? { providers: options.citationProviders }
        : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    review.integrityIssues.push(
      ...audits
        .filter((audit) => audit.status !== "verified")
        .map((audit) => ({
          type: "citation" as const,
          severity:
            audit.status === "retracted"
              ? ("blocking" as const)
              : audit.status === "suspicious"
                ? ("high-warning" as const)
                : ("medium-warning" as const),
          message: `${audit.kind.toUpperCase()} ${audit.value} is ${audit.status}.`,
          evidence: [audit.evidence],
        })),
    );
  }
  if (review.integrityIssues.some((issue) => issue.severity === "blocking")) {
    review.recommendation = "archive";
  }
  if (options.adversarial ?? config.review.adversarialPass) {
    review.adversarialChallenges = await adversarialReview(
      source,
      review,
      provider,
      usage,
    );
    review.usage = usage.result();
  }
  return review;
}

async function fastReview(
  paper: PaperPassport,
  provider: LlmProvider,
  usage: LlmUsageTracker,
  now: Date,
): Promise<PaperReview> {
  const candidate = paper.candidate;
  if (!candidate?.abstract && !candidate?.snippet) {
    throw new Error(`Fast review requires an abstract or snippet: ${paper.id}`);
  }
  const raw = await requestJson(
    provider,
    {
      purpose: "source-analysis",
      maxTokens: 2_000,
      prompt: `Review only reading relevance from title and abstract/snippet. Do not score importance, novelty, methodology, experiments, reproducibility, writing, theory, proof correctness, or scientific quality. Return JSON {paperType,personalRelevance,recommendation,estimatedReadMinutes,strengths,weaknesses,prerequisites,readingRoute}. personalRelevance is 0-1; recommendation is priority|deep-read|skim|archive.
Paper: ${JSON.stringify(candidate)}`,
    },
    parseRawFastReview,
    usage,
  );
  const dimensions = unknownDimensions(
    "Full text was not supplied; this dimension is unavailable.",
  );
  return {
    version: 1,
    id: `review-${randomUUID()}`,
    paperId: paper.id,
    sourceId: paper.metadata.id,
    ...(paper.lifecycle.latestVersionId
      ? { sourceVersion: paper.lifecycle.latestVersionId }
      : {}),
    level: "fast",
    paperType: raw.paperType,
    coverage: {
      fullText: false,
      sections: ["title", "abstract"],
      pages: [],
      coverageScore: 0.05,
    },
    dimensions,
    evidenceConfidence: 0.05,
    personalRelevance: raw.personalRelevance,
    recommendation: raw.recommendation,
    ...(raw.estimatedReadMinutes === undefined
      ? {}
      : { estimatedReadMinutes: raw.estimatedReadMinutes }),
    strengths: raw.strengths,
    weaknesses: raw.weaknesses,
    criticalIssues: [],
    prerequisites: raw.prerequisites,
    readingRoute: raw.readingRoute,
    adversarialChallenges: [],
    unresolvedChallenges: [],
    integrityIssues: [],
    model: provider.name,
    promptVersion: "reader-fast-v1",
    usage: usage.result(),
    createdAt: now.toISOString(),
  };
}

function buildGroundedReview(
  paper: PaperPassport,
  source: SourceArtifact,
  coverage: PaperReview["coverage"],
  raw: RawReview,
  model: string,
  usage: { inputTokens: number; outputTokens: number },
  level: "standard" | "deep",
  now: Date,
): PaperReview {
  const dimensions = Object.fromEntries(
    Object.entries(raw.dimensions).map(([name, dimension]) => [
      name,
      groundDimension(source, dimension, name),
    ]),
  ) as unknown as PaperReview["dimensions"];
  const { score, evidenceConfidence } = aggregateDimensions(
    dimensions,
    raw.paperType,
    coverage.coverageScore,
  );
  return {
    version: 1,
    id: `review-${randomUUID()}`,
    paperId: paper.id,
    sourceId: source.id,
    ...(paper.lifecycle.latestVersionId
      ? { sourceVersion: paper.lifecycle.latestVersionId }
      : {}),
    level,
    paperType: raw.paperType,
    coverage,
    dimensions,
    ...(score === undefined ? {} : { scientificQuality: score }),
    evidenceConfidence,
    personalRelevance: raw.personalRelevance,
    recommendation: raw.recommendation,
    ...(raw.estimatedReadMinutes === undefined
      ? {}
      : { estimatedReadMinutes: raw.estimatedReadMinutes }),
    strengths: raw.strengths,
    weaknesses: raw.weaknesses,
    criticalIssues: raw.criticalIssues,
    prerequisites: raw.prerequisites,
    readingRoute: raw.readingRoute,
    adversarialChallenges: [],
    unresolvedChallenges: [],
    model,
    promptVersion:
      level === "standard" ? "reader-standard-v1" : "reader-deep-v1",
    usage,
    createdAt: now.toISOString(),
  };
}

function groundDimension(
  source: SourceArtifact,
  raw: RawDimension,
  name: string,
): DimensionAssessment {
  if (raw.state !== "assessed") {
    if (raw.score !== undefined || raw.evidenceQuotes.length) {
      throw new Error(
        `${name} cannot include scores or evidence when state is ${raw.state}`,
      );
    }
    return {
      state: raw.state,
      confidence: raw.confidence,
      rationale: raw.rationale,
      evidence: [],
    };
  }
  if (raw.score === undefined) {
    throw new Error(`${name} assessed dimension requires a score`);
  }
  if (!raw.evidenceQuotes.length) {
    throw new Error(`${name} assessed dimension requires evidence quotes`);
  }
  return {
    state: "assessed",
    score: raw.score,
    confidence: raw.confidence,
    rationale: raw.rationale,
    evidence: raw.evidenceQuotes.map((quote) =>
      toReaderAnchor(findEvidenceAnchor(source, quote)),
    ),
  };
}

async function adversarialReview(
  source: SourceArtifact,
  review: PaperReview,
  provider: LlmProvider,
  usage: LlmUsageTracker,
): Promise<ReviewChallenge[]> {
  const raw = await requestJson(
    provider,
    {
      purpose: "relationship-analysis",
      maxTokens: 2_500,
      prompt: `Challenge this review using only the supplied source text. Return JSON {challenges:[{text:string,severity:"high"|"medium"|"low",evidenceQuotes:string[]}]}. Every challenge must include an exact source quote. Do not concede or change scores.
Review: ${JSON.stringify(review)}
Source: ${source.content.slice(0, 80_000)}`,
    },
    parseChallenges,
    usage,
  );
  return raw.map((challenge) => ({
    text: challenge.text,
    severity: challenge.severity,
    evidence: challenge.evidenceQuotes.map((quote) =>
      toReaderAnchor(findEvidenceAnchor(source, quote)),
    ),
  }));
}

function reviewPrompt(
  paper: PaperPassport,
  source: SourceArtifact,
  material: string,
  level: "standard" | "deep",
): string {
  return `Perform an evidence-grounded ${level} paper review. Separate scientific quality from personal relevance. For each dimension return {state:"assessed"|"unknown"|"not-applicable",score?:number,confidence:number,rationale:string,evidenceQuotes:string[]}. An assessed dimension requires a 0-10 score and exact verbatim source quotes. Unknown/not-applicable dimensions must omit score and use no evidence quotes. Return JSON {paperType,dimensions:{importance,novelty,methodology,experiments,reproducibility,writing,theory,completeness?,organization?},personalRelevance,recommendation,estimatedReadMinutes,strengths,weaknesses,criticalIssues,prerequisites,readingRoute}. personalRelevance is 0-1; recommendation is priority|deep-read|skim|archive.
Metadata: ${JSON.stringify(paper.metadata)}
Source ID: ${source.id}
Source material:
${material}`;
}

function parseRawReview(value: unknown): RawReview {
  const data = object(value, "Reader review");
  const dimensions = object(data.dimensions, "Reader review dimensions");
  const parsed = Object.fromEntries(
    [
      "importance",
      "novelty",
      "methodology",
      "experiments",
      "reproducibility",
      "writing",
      "theory",
      ...(dimensions.completeness === undefined ? [] : ["completeness"]),
      ...(dimensions.organization === undefined ? [] : ["organization"]),
    ].map((name) => [name, parseRawDimension(dimensions[name], name)]),
  ) as unknown as Record<DimensionName, RawDimension>;
  return {
    paperType: paperType(data.paperType),
    dimensions: parsed,
    personalRelevance: ratio(data.personalRelevance, "personalRelevance"),
    recommendation: recommendation(data.recommendation),
    ...(data.estimatedReadMinutes === undefined
      ? {}
      : {
          estimatedReadMinutes: integer(
            data.estimatedReadMinutes,
            "estimatedReadMinutes",
            1,
            10_000,
          ),
        }),
    strengths: strings(data.strengths, "strengths"),
    weaknesses: strings(data.weaknesses, "weaknesses"),
    criticalIssues: strings(data.criticalIssues, "criticalIssues"),
    prerequisites: strings(data.prerequisites, "prerequisites"),
    readingRoute: strings(data.readingRoute, "readingRoute"),
  };
}

function parseRawFastReview(value: unknown): RawFastReview {
  const data = object(value, "Fast review");
  return {
    paperType: paperType(data.paperType),
    personalRelevance: ratio(data.personalRelevance, "personalRelevance"),
    recommendation: recommendation(data.recommendation),
    ...(data.estimatedReadMinutes === undefined
      ? {}
      : {
          estimatedReadMinutes: integer(
            data.estimatedReadMinutes,
            "estimatedReadMinutes",
            1,
            10_000,
          ),
        }),
    strengths: strings(data.strengths, "strengths"),
    weaknesses: strings(data.weaknesses, "weaknesses"),
    prerequisites: strings(data.prerequisites, "prerequisites"),
    readingRoute: strings(data.readingRoute, "readingRoute"),
  };
}

function parseRawDimension(value: unknown, name: string): RawDimension {
  const data = object(value, `dimension ${name}`);
  const state = enumeration(
    data.state,
    ["assessed", "unknown", "not-applicable"],
    `${name}.state`,
  );
  return {
    state,
    ...(data.score === undefined
      ? {}
      : { score: bounded(data.score, `${name}.score`, 0, 10) }),
    confidence: ratio(data.confidence, `${name}.confidence`),
    rationale: text(data.rationale, `${name}.rationale`),
    evidenceQuotes: strings(data.evidenceQuotes, `${name}.evidenceQuotes`),
  };
}

function parseChallenges(value: unknown): Array<{
  text: string;
  severity: ReviewChallenge["severity"];
  evidenceQuotes: string[];
}> {
  const data = object(value, "Adversarial review");
  if (!Array.isArray(data.challenges)) {
    throw new Error("Adversarial challenges must be an array");
  }
  return data.challenges.map((item, index) => {
    const challenge = object(item, `challenge ${index}`);
    const evidenceQuotes = strings(
      challenge.evidenceQuotes,
      `challenge ${index} evidenceQuotes`,
    );
    if (!evidenceQuotes.length) {
      throw new Error(`challenge ${index} requires evidence quotes`);
    }
    return {
      text: text(challenge.text, `challenge ${index} text`),
      severity: enumeration(
        challenge.severity,
        ["high", "medium", "low"],
        `challenge ${index} severity`,
      ),
      evidenceQuotes,
    };
  });
}

function aggregateDimensions(
  dimensions: PaperReview["dimensions"],
  type: PaperType,
  coverageScore: number,
): { score?: number; evidenceConfidence: number } {
  const weights = weightsFor(type);
  let weightedScore = 0;
  let weightedConfidence = 0;
  let assessedWeight = 0;
  for (const [name, weight] of Object.entries(weights)) {
    const dimension = dimensions[name as DimensionName];
    if (!dimension || dimension.state !== "assessed") continue;
    weightedScore += dimension.score! * weight;
    weightedConfidence += dimension.confidence * weight;
    assessedWeight += weight;
  }
  if (!assessedWeight) {
    return { evidenceConfidence: 0 };
  }
  return {
    score: weightedScore / assessedWeight,
    evidenceConfidence: Math.min(
      1,
      (weightedConfidence / assessedWeight) * coverageScore * assessedWeight,
    ),
  };
}

function weightsFor(type: PaperType): Partial<Record<DimensionName, number>> {
  const common = {
    importance: 0.15,
    novelty: 0.15,
    methodology: 0.2,
    experiments: 0.2,
    reproducibility: 0.15,
    writing: 0.05,
    theory: 0.1,
  };
  switch (type) {
    case "theoretical":
      return {
        importance: 0.15,
        novelty: 0.2,
        methodology: 0.1,
        experiments: 0.05,
        reproducibility: 0.05,
        writing: 0.05,
        theory: 0.4,
      };
    case "survey":
      return {
        importance: 0.2,
        novelty: 0.05,
        methodology: 0.1,
        experiments: 0.05,
        reproducibility: 0.05,
        writing: 0.1,
        theory: 0.05,
        completeness: 0.25,
        organization: 0.15,
      };
    case "systems":
      return {
        importance: 0.15,
        novelty: 0.15,
        methodology: 0.2,
        experiments: 0.2,
        reproducibility: 0.25,
        writing: 0.05,
      };
    case "reproduction":
      return {
        importance: 0.1,
        novelty: 0.05,
        methodology: 0.2,
        experiments: 0.3,
        reproducibility: 0.3,
        writing: 0.05,
      };
    case "short":
      return {
        importance: 0.2,
        novelty: 0.25,
        methodology: 0.2,
        experiments: 0.1,
        reproducibility: 0.1,
        writing: 0.1,
        theory: 0.05,
      };
    default:
      return common;
  }
}

function unknownDimensions(rationale: string): PaperReview["dimensions"] {
  const dimension = (): DimensionAssessment => ({
    state: "unknown",
    confidence: 0,
    rationale,
    evidence: [],
  });
  return {
    importance: dimension(),
    novelty: dimension(),
    methodology: dimension(),
    experiments: dimension(),
    reproducibility: dimension(),
    writing: dimension(),
    theory: dimension(),
  };
}

async function resolveReviewerLlm(
  config: ResolvedReaderConfig,
  options: ReaderReviewOptions,
): Promise<LlmProvider> {
  if (options.llmProvider) return options.llmProvider;
  const wikiConfig = await loadConfig(config.root);
  return requireLlm(wikiConfig, {
    root: config.root,
    ...(options.approveLlm === true ? { approveLlm: true } : {}),
    ...(options.maxLlmTokens === undefined
      ? {}
      : { maxLlmTokens: options.maxLlmTokens }),
  });
}

function toReaderAnchor(anchor: {
  sourceId: string;
  quote: string;
  start: number;
  end: number;
  page?: number;
  section?: string;
}): EvidenceAnchor {
  return { ...anchor };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function ratio(value: unknown, name: string): number {
  return bounded(value, name, 0, 1);
}

function integer(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const result = bounded(value, name, minimum, maximum);
  if (!Number.isInteger(result)) throw new Error(`${name} must be an integer`);
  return result;
}

function bounded(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be from ${minimum} to ${maximum}`);
  }
  return value;
}

function enumeration<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${name} is invalid`);
  }
  return value as T;
}

function paperType(value: unknown): PaperType {
  return enumeration(
    value,
    [
      "empirical",
      "theoretical",
      "survey",
      "systems",
      "reproduction",
      "short",
      "other",
    ],
    "paperType",
  );
}

function recommendation(
  value: unknown,
): Exclude<ReadingRecommendation, "manual-review"> {
  return enumeration(
    value,
    ["priority", "deep-read", "skim", "archive"],
    "recommendation",
  );
}
