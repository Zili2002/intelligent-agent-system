import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  readJsonIfExists,
  withFileLock,
} from "@intelligent-agent/shared";
import { migrationStatePath, parseMigrationState } from "./migrations.js";
import { profilePath, subscriptionsPath } from "./paths.js";
import type {
  PaperPassport,
  PaperReview,
  ReaderMigrationState,
  ReaderSubscriptions,
  ReadingSession,
  ResearchProfile,
  ResolvedReaderConfig,
} from "./types.js";
import {
  parsePaperPassport,
  parsePaperReview,
  parseReadingSession,
  parseResearchProfile,
  parseSubscriptions,
  safeReaderId,
} from "./validation.js";

export async function savePaperPassport(
  config: ResolvedReaderConfig,
  passport: PaperPassport,
): Promise<string> {
  const parsed = parsePaperPassport(passport);
  const filePath = artifactPath(config.papersDir, parsed.id);
  await writeLocked(filePath, parsed);
  return filePath;
}

export function loadPaperPassport(
  config: ResolvedReaderConfig,
  paperId: string,
): Promise<PaperPassport | undefined> {
  return readJsonIfExists(
    artifactPath(config.papersDir, paperId),
    parsePaperPassport,
  );
}

export async function mutatePaperPassport(
  config: ResolvedReaderConfig,
  paperId: string,
  mutate: (
    current: PaperPassport | undefined,
  ) => PaperPassport | Promise<PaperPassport>,
): Promise<PaperPassport> {
  const filePath = artifactPath(config.papersDir, paperId);
  await mkdir(path.dirname(filePath), { recursive: true });
  return withFileLock(`${filePath}.lock`, async () => {
    const current = await readJsonIfExists(filePath, parsePaperPassport);
    const next = parsePaperPassport(await mutate(current));
    if (next.id !== paperId) {
      throw new Error(
        `Paper Passport mutation changed ID ${paperId} to ${next.id}`,
      );
    }
    await atomicWriteJson(filePath, next);
    return next;
  });
}

export async function listPaperPassports(
  config: ResolvedReaderConfig,
): Promise<PaperPassport[]> {
  return readArtifactDirectory(config.papersDir, parsePaperPassport);
}

export async function savePaperReview(
  config: ResolvedReaderConfig,
  review: PaperReview,
): Promise<string> {
  const parsed = parsePaperReview(review);
  const directory = path.join(
    config.reviewsDir,
    safeReaderId(parsed.paperId, "Paper Review paperId"),
  );
  const filePath = artifactPath(directory, parsed.id);
  await writeLocked(filePath, parsed);
  return filePath;
}

export function loadPaperReview(
  config: ResolvedReaderConfig,
  paperId: string,
  reviewId: string,
): Promise<PaperReview | undefined> {
  return readJsonIfExists(
    artifactPath(
      path.join(
        config.reviewsDir,
        safeReaderId(paperId, "Paper Review paperId"),
      ),
      reviewId,
    ),
    parsePaperReview,
  );
}

export async function listPaperReviews(
  config: ResolvedReaderConfig,
  paperId?: string,
): Promise<PaperReview[]> {
  if (paperId) {
    return (
      await readArtifactDirectory(
        path.join(
          config.reviewsDir,
          safeReaderId(paperId, "Paper Review paperId"),
        ),
        parsePaperReview,
      )
    ).sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        left.id.localeCompare(right.id),
    );
  }
  let entries;
  try {
    entries = await readdir(config.reviewsDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const reviews = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        readArtifactDirectory(
          path.join(config.reviewsDir, entry.name),
          parsePaperReview,
        ),
      ),
  );
  return reviews
    .flat()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function saveReadingSession(
  config: ResolvedReaderConfig,
  session: ReadingSession,
): Promise<string> {
  const parsed = parseReadingSession(session);
  const filePath = artifactPath(config.sessionsDir, parsed.id);
  await writeLocked(filePath, parsed);
  return filePath;
}

export function loadReadingSession(
  config: ResolvedReaderConfig,
  sessionId: string,
): Promise<ReadingSession | undefined> {
  return readJsonIfExists(
    artifactPath(config.sessionsDir, sessionId),
    parseReadingSession,
  );
}

export async function listReadingSessions(
  config: ResolvedReaderConfig,
): Promise<ReadingSession[]> {
  return readArtifactDirectory(config.sessionsDir, parseReadingSession);
}

export async function saveResearchProfile(
  config: ResolvedReaderConfig,
  profile: ResearchProfile,
): Promise<string> {
  const parsed = parseResearchProfile(profile);
  const filePath = profilePath(config);
  await writeLocked(filePath, parsed);
  return filePath;
}

export function loadResearchProfile(
  config: ResolvedReaderConfig,
): Promise<ResearchProfile | undefined> {
  return readJsonIfExists(profilePath(config), parseResearchProfile);
}

export async function saveSubscriptions(
  config: ResolvedReaderConfig,
  subscriptions: ReaderSubscriptions,
): Promise<string> {
  const parsed = parseSubscriptions(subscriptions);
  const filePath = subscriptionsPath(config);
  await writeLocked(filePath, parsed);
  return filePath;
}

export function loadSubscriptions(
  config: ResolvedReaderConfig,
): Promise<ReaderSubscriptions | undefined> {
  return readJsonIfExists(subscriptionsPath(config), parseSubscriptions);
}

export function loadMigrationState(
  config: ResolvedReaderConfig,
): Promise<ReaderMigrationState | undefined> {
  return readJsonIfExists(migrationStatePath(config), parseMigrationState);
}

async function readArtifactDirectory<T>(
  directory: string,
  parse: (value: unknown) => T,
): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const artifacts: T[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const value = await readJsonIfExists(path.join(directory, name), parse);
    if (value !== undefined) artifacts.push(value);
  }
  return artifacts;
}

async function writeLocked(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await withFileLock(`${filePath}.lock`, () =>
    atomicWriteJson(filePath, value),
  );
}

function artifactPath(directory: string, id: string): string {
  return path.join(directory, `${safeReaderId(id)}.json`);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
