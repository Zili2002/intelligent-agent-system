import {
  LlmUsageTracker,
  requestJson,
  type LlmProvider,
  type SearchResult,
} from "@intelligent-agent-system/llm-wiki-compiler";
import type {
  ReaderSubscription,
  ResearchProfile,
  ResolvedReaderConfig,
  TriageResult,
} from "./types.js";

export function deterministicTriage(
  result: SearchResult,
  subscription: ReaderSubscription,
  profile: ResearchProfile,
  config: ResolvedReaderConfig,
): TriageResult {
  const candidateTokens = tokens(
    [result.title, result.abstract, result.snippet].filter(Boolean).join(" "),
  );
  const profileTerms = [
    ...profile.explicit.topics,
    ...profile.explicit.methods,
    ...profile.learned.topics,
    ...profile.learned.methods,
    ...profile.learned.recentFocus,
  ];
  const profileTokens = tokens(
    [
      subscription.query,
      ...profileTerms.map((item) => item.term),
      ...subscription.tags,
    ].join(" "),
  );
  const queryTokens = tokens(
    [subscription.query, ...subscription.tags].join(" "),
  );
  const profileSimilarity = jaccard(candidateTokens, profileTokens);
  const keywordMatch = coverage(candidateTokens, queryTokens);
  const followedAuthors = new Set(
    profile.explicit.followedAuthors.map(normalizedName),
  );
  const authorMatch = result.authors?.some((author) =>
    followedAuthors.has(normalizedName(author)),
  )
    ? 1
    : 0;
  const weighted =
    profileSimilarity * config.triage.semanticWeight +
    keywordMatch * config.triage.keywordWeight +
    authorMatch * config.triage.authorWeight;
  const relevanceScore = clamp(weighted * (0.75 + 0.25 * subscription.weight));
  const reasons = [
    `profile similarity ${profileSimilarity.toFixed(2)}`,
    `query/tag coverage ${keywordMatch.toFixed(2)}`,
    ...(authorMatch ? ["followed author match"] : []),
  ];
  if (result.isRetracted === true) {
    reasons.push("provider reports the work as retracted");
  }
  return {
    relevanceScore,
    confidence: candidateTokens.size > 8 ? 0.7 : 0.4,
    recommendation:
      result.isRetracted === true
        ? "archive"
        : recommendationFor(relevanceScore, config.triage.minimumRelevance),
    reasons,
    signals: { profileSimilarity, keywordMatch, authorMatch },
    mode: "deterministic",
  };
}

export async function refineTriageWithLlm(
  result: SearchResult,
  subscription: ReaderSubscription,
  profile: ResearchProfile,
  deterministic: TriageResult,
  provider: LlmProvider,
  usage: LlmUsageTracker,
  minimumRelevance: number,
): Promise<TriageResult> {
  const llm = await requestJson(
    provider,
    {
      purpose: "screening",
      maxTokens: 1_200,
      prompt: `Evaluate only research relevance and reading utility from the supplied title and abstract/snippet. Do not score experiment quality, reproducibility, proof correctness, or final scientific quality because full text is not supplied. Return JSON {relevance:number,confidence:number,difficultyEstimate:number,reasons:string[]} with relevance/confidence from 0 to 1 and difficultyEstimate from 0 to 10.
Subscription: ${JSON.stringify(subscription)}
Explicit profile: ${JSON.stringify(profile.explicit)}
Candidate: ${JSON.stringify(result)}`,
    },
    parseLlmTriage,
    usage,
  );
  const relevanceScore = clamp(
    deterministic.relevanceScore * 0.6 + llm.relevance * 0.4,
  );
  return {
    ...deterministic,
    relevanceScore,
    confidence: clamp(deterministic.confidence * 0.5 + llm.confidence * 0.5),
    difficultyEstimate: llm.difficultyEstimate,
    recommendation:
      result.isRetracted === true
        ? "archive"
        : recommendationFor(relevanceScore, minimumRelevance),
    reasons: [...deterministic.reasons, ...llm.reasons],
    mode: "deterministic+llm",
  };
}

function parseLlmTriage(value: unknown): {
  relevance: number;
  confidence: number;
  difficultyEstimate: number;
  reasons: string[];
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Reader triage must be an object");
  }
  const data = value as Record<string, unknown>;
  const relevance = ratio(data.relevance, "relevance");
  const confidence = ratio(data.confidence, "confidence");
  const difficultyEstimate = boundedNumber(
    data.difficultyEstimate,
    "difficultyEstimate",
    0,
    10,
  );
  if (
    !Array.isArray(data.reasons) ||
    data.reasons.some((reason) => typeof reason !== "string" || !reason.trim())
  ) {
    throw new Error("Reader triage reasons must be non-empty strings");
  }
  return {
    relevance,
    confidence,
    difficultyEstimate,
    reasons: data.reasons,
  };
}

function recommendationFor(
  relevance: number,
  minimumRelevance: number,
): TriageResult["recommendation"] {
  if (relevance >= 0.8) return "priority";
  if (relevance >= 0.6) return "deep-read";
  if (relevance >= minimumRelevance) return "skim";
  return "archive";
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{Letter}\p{Number}]+/gu)
      ?.filter((token) => token.length > 1) ?? [],
  );
}

function coverage(candidate: Set<string>, query: Set<string>): number {
  if (!query.size) return 0;
  let matches = 0;
  for (const token of query) if (candidate.has(token)) matches += 1;
  return matches / query.size;
}

function jaccard(first: Set<string>, second: Set<string>): number {
  if (!first.size || !second.size) return 0;
  let intersection = 0;
  for (const token of first) if (second.has(token)) intersection += 1;
  return intersection / (first.size + second.size - intersection);
}

function normalizedName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function ratio(value: unknown, name: string): number {
  return boundedNumber(value, name, 0, 1);
}

function boundedNumber(
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

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
