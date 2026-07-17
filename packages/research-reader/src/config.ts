import path from "node:path";
import { atomicWriteJson, readJsonIfExists } from "@intelligent-agent/shared";
import { validateReaderManagedPaths } from "./path-safety.js";
import type { ReaderConfig, ResolvedReaderConfig } from "./types.js";

export const READER_CONFIG_FILE = ".research-reader-config.json";

export const DEFAULT_READER_CONFIG: ReaderConfig = {
  version: 1,
  metaPath: "meta/reader",
  reportsPath: "reports/reader",
  wikiPath: "wiki",
  tracking: {
    enabled: false,
    lookbackDays: 2,
    maxCandidatesPerRun: 100,
    maxLlmCandidatesPerRun: 20,
    maxFullTextDownloadsPerRun: 3,
    concurrency: 3,
    preferredLanguages: ["en"],
  },
  triage: {
    semanticWeight: 0.6,
    keywordWeight: 0.25,
    authorWeight: 0.15,
    minimumRelevance: 0.3,
  },
  review: {
    autoFastReview: false,
    autoStandardReview: false,
    requireFullTextForStandard: true,
    adversarialPass: true,
    citationIntegrity: true,
    temporalIntegrity: true,
    maxTokensPerRun: 100_000,
  },
  reading: {
    requireLevelConfirmation: true,
    autoCompileOnComplete: false,
    retentionChecksEnabled: false,
  },
  profile: {
    learningEnabled: false,
    minimumExplicitFeedback: 20,
    maximumLearnedWeightChange: 0.1,
  },
  scheduler: {
    enabled: false,
    timezone: "local",
    intervalSeconds: 86_400,
    jitterSeconds: 900,
    staleLockSeconds: 1_800,
  },
};

export async function initializeReaderConfig(
  root = process.cwd(),
): Promise<{ config: ResolvedReaderConfig; created: boolean }> {
  const resolvedRoot = path.resolve(root);
  const configPath = path.join(resolvedRoot, READER_CONFIG_FILE);
  const existing = await readJsonIfExists(configPath, validateReaderConfig);
  if (existing) {
    const config = resolveReaderConfig(existing, resolvedRoot);
    await validateReaderManagedPaths(config);
    return {
      config,
      created: false,
    };
  }
  await atomicWriteJson(configPath, DEFAULT_READER_CONFIG);
  const config = resolveReaderConfig(
    structuredClone(DEFAULT_READER_CONFIG),
    resolvedRoot,
  );
  await validateReaderManagedPaths(config);
  return {
    config,
    created: true,
  };
}

export async function loadReaderConfig(
  root = process.cwd(),
): Promise<ResolvedReaderConfig> {
  const resolvedRoot = path.resolve(root);
  const configPath = path.join(resolvedRoot, READER_CONFIG_FILE);
  const config = await readJsonIfExists(configPath, validateReaderConfig);
  if (!config) {
    throw new Error(
      `Research Reader is not initialized at ${resolvedRoot}; run research-reader init`,
    );
  }
  const resolved = resolveReaderConfig(config, resolvedRoot);
  await validateReaderManagedPaths(resolved);
  return resolved;
}

export function validateReaderConfig(value: unknown): ReaderConfig {
  const data = record(value, "Reader config");
  if (data.version !== 1) throw new Error("Reader config version must be 1");
  const tracking = record(data.tracking, "Reader config tracking");
  const triage = record(data.triage, "Reader config triage");
  const review = record(data.review, "Reader config review");
  const reading = record(data.reading, "Reader config reading");
  const profile = record(data.profile, "Reader config profile");
  const scheduler = record(data.scheduler, "Reader config scheduler");
  const config: ReaderConfig = {
    version: 1,
    metaPath: relativePath(data.metaPath, "metaPath"),
    reportsPath: relativePath(data.reportsPath, "reportsPath"),
    wikiPath: relativePath(data.wikiPath, "wikiPath"),
    tracking: {
      enabled: boolean(tracking.enabled, "tracking.enabled"),
      lookbackDays: integer(
        tracking.lookbackDays,
        "tracking.lookbackDays",
        0,
        365,
      ),
      maxCandidatesPerRun: integer(
        tracking.maxCandidatesPerRun,
        "tracking.maxCandidatesPerRun",
        1,
        10_000,
      ),
      maxLlmCandidatesPerRun: integer(
        tracking.maxLlmCandidatesPerRun,
        "tracking.maxLlmCandidatesPerRun",
        0,
        10_000,
      ),
      maxFullTextDownloadsPerRun: integer(
        tracking.maxFullTextDownloadsPerRun,
        "tracking.maxFullTextDownloadsPerRun",
        0,
        1_000,
      ),
      concurrency: integer(tracking.concurrency, "tracking.concurrency", 1, 32),
      preferredLanguages: stringArray(
        tracking.preferredLanguages,
        "tracking.preferredLanguages",
      ),
    },
    triage: {
      semanticWeight: ratio(triage.semanticWeight, "triage.semanticWeight"),
      keywordWeight: ratio(triage.keywordWeight, "triage.keywordWeight"),
      authorWeight: ratio(triage.authorWeight, "triage.authorWeight"),
      minimumRelevance: ratio(
        triage.minimumRelevance,
        "triage.minimumRelevance",
      ),
    },
    review: {
      autoFastReview: boolean(review.autoFastReview, "review.autoFastReview"),
      autoStandardReview: boolean(
        review.autoStandardReview,
        "review.autoStandardReview",
      ),
      requireFullTextForStandard: boolean(
        review.requireFullTextForStandard,
        "review.requireFullTextForStandard",
      ),
      adversarialPass: boolean(
        review.adversarialPass,
        "review.adversarialPass",
      ),
      citationIntegrity: boolean(
        review.citationIntegrity,
        "review.citationIntegrity",
      ),
      temporalIntegrity: boolean(
        review.temporalIntegrity,
        "review.temporalIntegrity",
      ),
      maxTokensPerRun: integer(
        review.maxTokensPerRun,
        "review.maxTokensPerRun",
        1,
        1_000_000_000,
      ),
    },
    reading: {
      requireLevelConfirmation: boolean(
        reading.requireLevelConfirmation,
        "reading.requireLevelConfirmation",
      ),
      autoCompileOnComplete: boolean(
        reading.autoCompileOnComplete,
        "reading.autoCompileOnComplete",
      ),
      retentionChecksEnabled: boolean(
        reading.retentionChecksEnabled,
        "reading.retentionChecksEnabled",
      ),
    },
    profile: {
      learningEnabled: boolean(
        profile.learningEnabled,
        "profile.learningEnabled",
      ),
      minimumExplicitFeedback: integer(
        profile.minimumExplicitFeedback,
        "profile.minimumExplicitFeedback",
        1,
        100_000,
      ),
      maximumLearnedWeightChange: ratio(
        profile.maximumLearnedWeightChange,
        "profile.maximumLearnedWeightChange",
      ),
    },
    scheduler: {
      enabled: boolean(scheduler.enabled, "scheduler.enabled"),
      ...(scheduler.cron === undefined
        ? {}
        : { cron: nonEmptyString(scheduler.cron, "scheduler.cron") }),
      timezone: nonEmptyString(scheduler.timezone, "scheduler.timezone"),
      intervalSeconds: integer(
        scheduler.intervalSeconds,
        "scheduler.intervalSeconds",
        1,
        31_536_000,
      ),
      jitterSeconds: integer(
        scheduler.jitterSeconds,
        "scheduler.jitterSeconds",
        0,
        86_400,
      ),
      staleLockSeconds: integer(
        scheduler.staleLockSeconds,
        "scheduler.staleLockSeconds",
        1,
        604_800,
      ),
    },
  };
  const triageTotal =
    config.triage.semanticWeight +
    config.triage.keywordWeight +
    config.triage.authorWeight;
  if (Math.abs(triageTotal - 1) > 0.000_001) {
    throw new Error("Reader triage weights must sum to 1");
  }
  return config;
}

export function resolveReaderConfig(
  config: ReaderConfig,
  root: string,
): ResolvedReaderConfig {
  const resolvedRoot = path.resolve(root);
  const metaDir = containedPath(resolvedRoot, config.metaPath);
  const reportsDir = containedPath(resolvedRoot, config.reportsPath);
  const wikiDir = containedPath(resolvedRoot, config.wikiPath);
  return {
    ...config,
    root: resolvedRoot,
    configPath: path.join(resolvedRoot, READER_CONFIG_FILE),
    metaDir,
    papersDir: path.join(metaDir, "papers"),
    reviewsDir: path.join(metaDir, "reviews"),
    sessionsDir: path.join(metaDir, "reading-sessions"),
    annotationsDir: path.join(metaDir, "annotations"),
    notesDir: path.join(metaDir, "notes"),
    retentionDir: path.join(metaDir, "retention"),
    patternsDir: path.join(metaDir, "patterns"),
    approvalsDir: path.join(metaDir, "approvals"),
    calibrationDir: path.join(metaDir, "calibration"),
    runsDir: path.join(metaDir, "runs"),
    migrationsDir: path.join(metaDir, "migrations"),
    reportsDir,
    dailyReportsDir: path.join(reportsDir, "daily"),
    weeklyReportsDir: path.join(reportsDir, "weekly"),
    trendsReportsDir: path.join(reportsDir, "trends"),
    surveyReportsDir: path.join(reportsDir, "survey"),
    wikiDir,
  };
}

function containedPath(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  const relationship = path.relative(root, target);
  if (
    relationship === ".." ||
    relationship.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relationship)
  ) {
    throw new Error(`Reader path escapes repository root: ${relative}`);
  }
  return target;
}

function relativePath(value: unknown, name: string): string {
  const result = nonEmptyString(value, name);
  if (path.isAbsolute(result)) throw new Error(`${name} must be relative`);
  const normalized = path.normalize(result);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${name} must stay inside the repository root`);
  }
  return normalized;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function integer(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function ratio(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(`${name} must be from 0 to 1`);
  }
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}
