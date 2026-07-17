import type {
  DimensionAssessment,
  PaperPassport,
  PaperReview,
  ReaderSubscription,
  ReaderSubscriptions,
  ReadingMode,
  ReadingSession,
  ReadingStatus,
  ResearchProfile,
  ReviewLevel,
} from "./types.js";

const READING_STATUSES = new Set<ReadingStatus>([
  "unread",
  "queued",
  "reading",
  "read",
  "revisit",
  "dismissed",
]);
const REVIEW_LEVELS = new Set<ReviewLevel>(["fast", "standard", "deep"]);
const READING_MODES = new Set<ReadingMode>([
  "quick-scan",
  "guided-read",
  "deep-dive",
  "compare",
  "extract",
]);
const PAPER_TYPES = new Set([
  "empirical",
  "theoretical",
  "survey",
  "systems",
  "reproduction",
  "short",
  "other",
]);

export function safeReaderId(value: unknown, name = "Reader ID"): string {
  const id = nonEmptyString(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) {
    throw new Error(`${name} contains unsafe characters: ${id}`);
  }
  return id;
}

export function parsePaperPassport(value: unknown): PaperPassport {
  const data = versionedRecord(value, "Paper Passport");
  safeReaderId(data.id, "Paper Passport ID");
  nonEmptyString(data.canonicalKey, "Paper Passport canonicalKey");
  stringArray(data.sourceIds, "Paper Passport sourceIds");
  record(data.metadata, "Paper Passport metadata");
  if (data.candidate !== undefined) {
    record(data.candidate, "Paper Passport candidate");
  }
  array(data.discovery, "Paper Passport discovery");
  const acquisition = record(data.acquisition, "Paper Passport acquisition");
  enumValue(
    acquisition.status,
    ["metadata-only", "available", "failed"],
    "Paper Passport acquisition status",
  );
  if (data.triage !== undefined) {
    const triage = record(data.triage, "Paper Passport triage");
    ratio(triage.relevanceScore, "Paper Passport relevanceScore");
    ratio(triage.confidence, "Paper Passport triage confidence");
    stringArray(triage.reasons, "Paper Passport triage reasons");
  }
  const reading = record(data.reading, "Paper Passport reading");
  enumSet(reading.status, READING_STATUSES, "Paper Passport reading status");
  integer(reading.priority, "Paper Passport reading priority", 0, 100);
  stringArray(reading.userTags, "Paper Passport userTags");
  stringArray(data.reviewIds, "Paper Passport reviewIds");
  const knowledge = record(data.knowledge, "Paper Passport knowledge");
  boolean(knowledge.compiled, "Paper Passport knowledge.compiled");
  stringArray(knowledge.claimIds, "Paper Passport claimIds");
  stringArray(knowledge.wikiPaths, "Paper Passport wikiPaths");
  const lifecycle = record(data.lifecycle, "Paper Passport lifecycle");
  boolean(lifecycle.reviewStale, "Paper Passport lifecycle.reviewStale");
  boolean(lifecycle.retracted, "Paper Passport lifecycle.retracted");
  isoTimestamp(data.createdAt, "Paper Passport createdAt");
  isoTimestamp(data.updatedAt, "Paper Passport updatedAt");
  return data as unknown as PaperPassport;
}

export function parsePaperReview(value: unknown): PaperReview {
  const data = versionedRecord(value, "Paper Review");
  safeReaderId(data.id, "Paper Review ID");
  safeReaderId(data.paperId, "Paper Review paperId");
  nonEmptyString(data.sourceId, "Paper Review sourceId");
  enumSet(data.level, REVIEW_LEVELS, "Paper Review level");
  enumSet(data.paperType, PAPER_TYPES, "Paper Review paperType");
  const coverage = record(data.coverage, "Paper Review coverage");
  boolean(coverage.fullText, "Paper Review coverage.fullText");
  stringArray(coverage.sections, "Paper Review coverage.sections");
  numberArray(coverage.pages, "Paper Review coverage.pages");
  ratio(coverage.coverageScore, "Paper Review coverage.coverageScore");
  const dimensions = record(data.dimensions, "Paper Review dimensions");
  for (const name of [
    "importance",
    "novelty",
    "methodology",
    "experiments",
    "reproducibility",
    "writing",
    "theory",
  ]) {
    parseDimension(dimensions[name], `Paper Review ${name}`);
  }
  stringArray(data.strengths, "Paper Review strengths");
  stringArray(data.weaknesses, "Paper Review weaknesses");
  stringArray(data.criticalIssues, "Paper Review criticalIssues");
  stringArray(data.prerequisites, "Paper Review prerequisites");
  stringArray(data.readingRoute, "Paper Review readingRoute");
  for (const challenge of array(
    data.adversarialChallenges,
    "Paper Review challenges",
  )) {
    const parsed = record(challenge, "Paper Review challenge");
    nonEmptyString(parsed.text, "Paper Review challenge text");
    enumValue(
      parsed.severity,
      ["high", "medium", "low"],
      "Paper Review challenge severity",
    );
    array(parsed.evidence, "Paper Review challenge evidence");
  }
  stringArray(data.unresolvedChallenges, "Paper Review unresolvedChallenges");
  if (data.integrityIssues !== undefined) {
    for (const issue of array(
      data.integrityIssues,
      "Paper Review integrityIssues",
    )) {
      const parsed = record(issue, "Paper Review integrity issue");
      enumValue(
        parsed.type,
        ["evidence", "citation", "temporal", "retraction", "coverage"],
        "Paper Review integrity issue type",
      );
      enumValue(
        parsed.severity,
        ["blocking", "high-warning", "medium-warning", "advisory"],
        "Paper Review integrity issue severity",
      );
      nonEmptyString(parsed.message, "Paper Review integrity issue message");
      array(parsed.evidence, "Paper Review integrity issue evidence");
    }
  }
  if (data.scientificQuality !== undefined) {
    number(data.scientificQuality, "Paper Review scientificQuality", 0, 10);
    const assessed = Object.values(dimensions).some(
      (dimension) =>
        typeof dimension === "object" &&
        dimension !== null &&
        !Array.isArray(dimension) &&
        "state" in dimension &&
        dimension.state === "assessed",
    );
    if (!assessed) {
      throw new Error(
        "Paper Review scientificQuality requires an assessed dimension",
      );
    }
  }
  ratio(data.evidenceConfidence, "Paper Review evidenceConfidence");
  ratio(data.personalRelevance, "Paper Review personalRelevance");
  enumValue(
    data.recommendation,
    ["priority", "deep-read", "skim", "archive"],
    "Paper Review recommendation",
  );
  isoTimestamp(data.createdAt, "Paper Review createdAt");
  return data as unknown as PaperReview;
}

export function parseReadingSession(value: unknown): ReadingSession {
  const data = versionedRecord(value, "Reading Session");
  safeReaderId(data.id, "Reading Session ID");
  safeReaderId(data.paperId, "Reading Session paperId");
  enumSet(data.mode, READING_MODES, "Reading Session mode");
  enumValue(
    data.intent,
    ["exploratory", "goal-oriented"],
    "Reading Session intent",
  );
  enumValue(
    data.status,
    ["active", "paused", "completed"],
    "Reading Session status",
  );
  array(data.checkpoints, "Reading Session checkpoints");
  record(data.progress, "Reading Session progress");
  array(data.questions, "Reading Session questions");
  isoTimestamp(data.createdAt, "Reading Session createdAt");
  isoTimestamp(data.updatedAt, "Reading Session updatedAt");
  return data as unknown as ReadingSession;
}

export function parseResearchProfile(value: unknown): ResearchProfile {
  const data = versionedRecord(value, "Research Profile");
  nonEmptyString(data.profileVersion, "Research Profile profileVersion");
  const explicit = record(data.explicit, "Research Profile explicit");
  weightedTerms(explicit.topics, "Research Profile topics");
  weightedTerms(explicit.methods, "Research Profile methods");
  stringArray(explicit.followedAuthors, "Research Profile followedAuthors");
  stringArray(explicit.excludedTopics, "Research Profile excludedTopics");
  stringArray(
    explicit.preferredLanguages,
    "Research Profile preferredLanguages",
  );
  weightedTerms(explicit.expertiseByTopic, "Research Profile expertiseByTopic");
  const learned = record(data.learned, "Research Profile learned");
  for (const field of [
    "topics",
    "methods",
    "recentFocus",
    "strongAreas",
    "weakAreas",
    "questionTopics",
  ]) {
    weightedTerms(learned[field], `Research Profile learned.${field}`);
  }
  ratio(learned.confidence, "Research Profile learned.confidence");
  integer(
    learned.sampleCount,
    "Research Profile learned.sampleCount",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  isoTimestamp(data.updatedAt, "Research Profile updatedAt");
  return data as unknown as ResearchProfile;
}

export function parseSubscriptions(value: unknown): ReaderSubscriptions {
  const data = versionedRecord(value, "Reader subscriptions");
  const items = array(data.items, "Reader subscriptions items").map(
    parseSubscription,
  );
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) {
    throw new Error("Reader subscription IDs must be unique");
  }
  return { version: 1, items };
}

function parseSubscription(value: unknown): ReaderSubscription {
  const data = versionedRecord(value, "Reader subscription");
  safeReaderId(data.id, "Reader subscription ID");
  nonEmptyString(data.name, "Reader subscription name");
  boolean(data.enabled, "Reader subscription enabled");
  enumValue(
    data.kind,
    ["query", "category", "author", "paper"],
    "Reader subscription kind",
  );
  nonEmptyString(data.query, "Reader subscription query");
  ratio(data.weight, "Reader subscription weight");
  stringArray(data.tags, "Reader subscription tags");
  stringArray(
    data.preferredLanguages,
    "Reader subscription preferredLanguages",
  );
  isoTimestamp(data.createdAt, "Reader subscription createdAt");
  isoTimestamp(data.updatedAt, "Reader subscription updatedAt");
  return data as unknown as ReaderSubscription;
}

function parseDimension(value: unknown, name: string): DimensionAssessment {
  const data = record(value, name);
  const state = enumValue(
    data.state,
    ["assessed", "unknown", "not-applicable"],
    `${name} state`,
  );
  if (state === "assessed" && data.score === undefined) {
    throw new Error(`${name} assessed dimensions require a score`);
  }
  if (state !== "assessed" && data.score !== undefined) {
    throw new Error(`${name} cannot score an unavailable dimension`);
  }
  if (data.score !== undefined) number(data.score, `${name} score`, 0, 10);
  ratio(data.confidence, `${name} confidence`);
  if (typeof data.rationale !== "string") {
    throw new Error(`${name} rationale must be a string`);
  }
  const evidence = array(data.evidence, `${name} evidence`);
  if (state === "assessed" && evidence.length === 0) {
    throw new Error(`${name} assessed dimensions require evidence`);
  }
  return data as unknown as DimensionAssessment;
}

function versionedRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
  const data = record(value, name);
  if (data.version !== 1) throw new Error(`${name} version must be 1`);
  return data;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value;
}

function numberArray(value: unknown, name: string): number[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "number" || !Number.isFinite(item))
  ) {
    throw new Error(`${name} must be an array of numbers`);
  }
  return value;
}

function weightedTerms(value: unknown, name: string): void {
  for (const item of array(value, name)) {
    const term = record(item, `${name} item`);
    nonEmptyString(term.term, `${name} term`);
    ratio(term.weight, `${name} weight`);
  }
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function number(
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

function integer(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const result = number(value, name, minimum, maximum);
  if (!Number.isInteger(result)) throw new Error(`${name} must be an integer`);
  return result;
}

function ratio(value: unknown, name: string): number {
  return number(value, name, 0, 1);
}

function enumSet<T extends string>(
  value: unknown,
  allowed: Set<T>,
  name: string,
): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new Error(`${name} is invalid`);
  }
  return value as T;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${name} is invalid`);
  }
  return value as T;
}

function isoTimestamp(value: unknown, name: string): string {
  const result = nonEmptyString(value, name);
  if (Number.isNaN(Date.parse(result))) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
  return result;
}
