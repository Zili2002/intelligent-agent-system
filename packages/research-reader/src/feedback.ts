import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendJsonLine, readJsonLines } from "@intelligent-agent/shared";
import {
  listPaperPassports,
  loadPaperPassport,
  loadResearchProfile,
  saveResearchProfile,
} from "./store.js";
import type {
  ReaderFeedbackEvent,
  ResearchProfile,
  ResolvedReaderConfig,
  WeightedTerm,
} from "./types.js";

const FEEDBACK_FILE = "feedback.jsonl";

export type FeedbackInput = Omit<
  ReaderFeedbackEvent,
  "version" | "id" | "createdAt"
>;

export async function recordFeedback(
  config: ResolvedReaderConfig,
  input: FeedbackInput,
  now = new Date(),
): Promise<ReaderFeedbackEvent> {
  if (!(await loadPaperPassport(config, input.paperId))) {
    throw new Error(`Paper not found: ${input.paperId}`);
  }
  validateFeedback(input);
  const event: ReaderFeedbackEvent = {
    version: 1,
    id: `feedback-${randomUUID()}`,
    ...structuredClone(input),
    createdAt: now.toISOString(),
  };
  await appendJsonLine(feedbackPath(config), event);
  return event;
}

export function listFeedback(
  config: ResolvedReaderConfig,
  limit?: number,
): Promise<ReaderFeedbackEvent[]> {
  return readJsonLines(feedbackPath(config), parseFeedback, {
    ...(limit === undefined ? {} : { limit }),
  });
}

export async function updateExplicitProfile(
  config: ResolvedReaderConfig,
  input: {
    topics?: string[];
    methods?: string[];
    followedAuthors?: string[];
    excludedTopics?: string[];
    preferredLanguages?: string[];
  },
  now = new Date(),
): Promise<ResearchProfile> {
  const profile = await loadResearchProfile(config);
  if (!profile) throw new Error("Research Profile is missing");
  if (input.topics) profile.explicit.topics = explicitTerms(input.topics);
  if (input.methods) profile.explicit.methods = explicitTerms(input.methods);
  if (input.followedAuthors) {
    profile.explicit.followedAuthors = unique(input.followedAuthors);
  }
  if (input.excludedTopics) {
    profile.explicit.excludedTopics = unique(input.excludedTopics);
  }
  if (input.preferredLanguages) {
    profile.explicit.preferredLanguages = unique(input.preferredLanguages);
  }
  const timestamp = now.toISOString();
  profile.profileVersion = `profile-${timestamp}`;
  profile.updatedAt = timestamp;
  await saveResearchProfile(config, profile);
  return profile;
}

export async function rebuildResearchProfile(
  config: ResolvedReaderConfig,
  options: { force?: boolean; now?: Date } = {},
): Promise<ResearchProfile> {
  if (!config.profile.learningEnabled && !options.force) {
    throw new Error(
      "Profile learning is disabled; use force only after explicit user action",
    );
  }

  const profile = await loadResearchProfile(config);
  if (!profile) throw new Error("Research Profile is missing");
  const [feedback, papers] = await Promise.all([
    listFeedback(config),
    listPaperPassports(config),
  ]);
  const explicit = feedback.filter((event) => event.explicit);
  profile.learned.sampleCount = explicit.length;
  profile.learned.confidence = Math.min(
    1,
    explicit.length / config.profile.minimumExplicitFeedback,
  );
  if (explicit.length >= config.profile.minimumExplicitFeedback) {
    const paperMap = new Map(papers.map((paper) => [paper.id, paper]));
    const topicTargets = scoreTerms(feedback, paperMap);
    profile.learned.topics = boundedTerms(
      profile.learned.topics,
      topicTargets,
      config.profile.maximumLearnedWeightChange,
    );
    profile.learned.recentFocus = boundedTerms(
      profile.learned.recentFocus,
      scoreTerms(feedback.slice(-20), paperMap),
      config.profile.maximumLearnedWeightChange,
    );
    profile.learned.questionTopics = boundedTerms(
      profile.learned.questionTopics,
      scoreQuestionTopics(feedback),
      config.profile.maximumLearnedWeightChange,
    );
    profile.learned.strongAreas = understandingTerms(papers, "strong");
    profile.learned.weakAreas = understandingTerms(papers, "weak");
  }
  const timestamp = (options.now ?? new Date()).toISOString();
  profile.profileVersion = `profile-${timestamp}`;
  profile.updatedAt = timestamp;
  await saveResearchProfile(config, profile);
  return profile;
}

function scoreTerms(
  feedback: ReaderFeedbackEvent[],
  papers: Map<string, Awaited<ReturnType<typeof listPaperPassports>>[number]>,
): Map<string, number> {
  const totals = new Map<string, { total: number; count: number }>();
  for (const event of feedback) {
    const paper = papers.get(event.paperId);
    if (!paper) continue;
    const strength = signalStrength(event);
    const terms = new Set([
      ...tokens(paper.metadata.title),
      ...paper.reading.userTags.flatMap(tokens),
      ...(event.topics ?? []).flatMap(tokens),
    ]);
    for (const term of terms) {
      const current = totals.get(term) ?? { total: 0, count: 0 };
      current.total += strength;
      current.count += 1;
      totals.set(term, current);
    }
  }
  return new Map(
    [...totals].map(([term, value]) => [
      term,
      value.total / Math.max(1, value.count),
    ]),
  );
}

function scoreQuestionTopics(
  feedback: ReaderFeedbackEvent[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of feedback) {
    if (event.type !== "question-topic") continue;
    for (const topic of event.topics ?? []) {
      for (const token of tokens(topic)) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
  }
  const maximum = Math.max(1, ...counts.values());
  return new Map([...counts].map(([term, count]) => [term, count / maximum]));
}

function understandingTerms(
  papers: Awaited<ReturnType<typeof listPaperPassports>>,
  kind: "strong" | "weak",
): WeightedTerm[] {
  const counts = new Map<string, number>();
  for (const paper of papers) {
    const understanding = paper.reading.understandingScore;
    if (
      understanding === undefined ||
      (kind === "strong" ? understanding < 4 : understanding > 2)
    ) {
      continue;
    }
    for (const token of tokens(paper.metadata.title)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const maximum = Math.max(1, ...counts.values());
  return [...counts]
    .map(([term, count]) => ({ term, weight: count / maximum }))
    .sort(
      (left, right) =>
        right.weight - left.weight || left.term.localeCompare(right.term),
    )
    .slice(0, 20);
}

function boundedTerms(
  existing: WeightedTerm[],
  targets: Map<string, number>,
  maximumChange: number,
): WeightedTerm[] {
  const current = new Map(existing.map((item) => [item.term, item.weight]));
  for (const [term, target] of targets) {
    const prior = current.get(term) ?? 0;
    const change = Math.max(
      -maximumChange,
      Math.min(maximumChange, target - prior),
    );
    current.set(term, clamp(prior + change));
  }
  return [...current]
    .map(([term, weight]) => ({ term, weight }))
    .filter((item) => item.weight > 0)
    .sort(
      (left, right) =>
        right.weight - left.weight || left.term.localeCompare(right.term),
    )
    .slice(0, 50);
}

function signalStrength(event: ReaderFeedbackEvent): number {
  const explicitFactor = event.explicit ? 1 : 0.25;
  switch (event.type) {
    case "quality-rating":
    case "personal-value":
      return ((event.value ?? 0) / 10) * explicitFactor;
    case "recommendation-feedback":
      return (event.accepted ? 0.9 : 0.2) * explicitFactor;
    case "reading-completed":
      return 0.8 * explicitFactor;
    case "reading-abandoned":
      return 0.2 * explicitFactor;
    case "question-topic":
      return 0.5 * explicitFactor;
  }
}

function validateFeedback(input: FeedbackInput): void {
  if (
    (input.type === "quality-rating" || input.type === "personal-value") &&
    (input.value === undefined ||
      !Number.isFinite(input.value) ||
      input.value < 0 ||
      input.value > 10)
  ) {
    throw new Error(`${input.type} requires a value from 0 to 10`);
  }
  if (
    input.type === "recommendation-feedback" &&
    input.accepted === undefined
  ) {
    throw new Error("recommendation-feedback requires accepted");
  }
  if (
    input.type === "question-topic" &&
    (!input.topics?.length || input.topics.some((topic) => !topic.trim()))
  ) {
    throw new Error("question-topic requires non-empty topics");
  }
}

function parseFeedback(value: unknown): ReaderFeedbackEvent {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("paperId" in value) ||
    typeof value.paperId !== "string" ||
    !("type" in value) ||
    typeof value.type !== "string" ||
    !("explicit" in value) ||
    typeof value.explicit !== "boolean" ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string"
  ) {
    throw new Error("Invalid Reader feedback event");
  }
  return value as ReaderFeedbackEvent;
}

function feedbackPath(config: ResolvedReaderConfig): string {
  return path.join(config.metaDir, FEEDBACK_FILE);
}

function tokens(value: string): string[] {
  return (
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{Letter}\p{Number}]+/gu)
      ?.filter((token) => token.length > 2) ?? []
  );
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function explicitTerms(values: string[]): WeightedTerm[] {
  return unique(values).map((term) => ({ term, weight: 1 }));
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
