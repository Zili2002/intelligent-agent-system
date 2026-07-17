import { mkdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, readJsonIfExists } from "@intelligent-agent/shared";
import { WikiCompiler } from "@intelligent-agent-system/llm-wiki-compiler";
import { initializeReaderConfig } from "./config.js";
import { ensureMigrationState } from "./migrations.js";
import { profilePath, subscriptionsPath } from "./paths.js";
import { initializeReasoningPatterns } from "./patterns.js";
import { getReaderStatus } from "./status.js";
import type {
  ReaderInitResult,
  ReaderSubscriptions,
  ResearchProfile,
  ResolvedReaderConfig,
} from "./types.js";
import { parseResearchProfile, parseSubscriptions } from "./validation.js";

export async function initResearchReader(
  root = process.cwd(),
): Promise<ReaderInitResult> {
  const initialized = await initializeReaderConfig(root);
  const config = initialized.config;
  await new WikiCompiler({ root: config.root }).init();
  await Promise.all(
    readerDirectories(config).map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  await ensureMigrationState(config);
  await initializeProfile(config);
  await initializeSubscriptions(config);
  await initializeReasoningPatterns(config);
  return {
    root: config.root,
    configPath: config.configPath,
    createdConfig: initialized.created,
    status: await getReaderStatus(config),
  };
}

function readerDirectories(config: ResolvedReaderConfig): string[] {
  return [
    config.metaDir,
    config.papersDir,
    config.reviewsDir,
    config.sessionsDir,
    config.annotationsDir,
    config.notesDir,
    config.retentionDir,
    config.patternsDir,
    config.approvalsDir,
    config.calibrationDir,
    config.runsDir,
    path.join(config.runsDir, "locks"),
    config.migrationsDir,
    config.reportsDir,
    config.dailyReportsDir,
    config.weeklyReportsDir,
    config.trendsReportsDir,
    config.surveyReportsDir,
    path.join(config.wikiDir, "papers"),
    path.join(config.wikiDir, "methods"),
    path.join(config.wikiDir, "datasets"),
    path.join(config.wikiDir, "comparisons"),
  ];
}

async function initializeProfile(config: ResolvedReaderConfig): Promise<void> {
  const filePath = profilePath(config);
  if (await readJsonIfExists(filePath, parseResearchProfile)) return;
  const now = new Date().toISOString();
  const profile: ResearchProfile = {
    version: 1,
    profileVersion: `profile-${now}`,
    explicit: {
      topics: [],
      methods: [],
      followedAuthors: [],
      excludedTopics: [],
      preferredLanguages: [...config.tracking.preferredLanguages],
      expertiseByTopic: [],
    },
    learned: {
      topics: [],
      methods: [],
      recentFocus: [],
      strongAreas: [],
      weakAreas: [],
      questionTopics: [],
      confidence: 0,
      sampleCount: 0,
    },
    updatedAt: now,
  };
  await atomicWriteJson(filePath, profile);
}

async function initializeSubscriptions(
  config: ResolvedReaderConfig,
): Promise<void> {
  const filePath = subscriptionsPath(config);
  if (await readJsonIfExists(filePath, parseSubscriptions)) return;
  const subscriptions: ReaderSubscriptions = { version: 1, items: [] };
  await atomicWriteJson(filePath, subscriptions);
}
