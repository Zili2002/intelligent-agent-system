import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { ResolvedReaderConfig } from "./types.js";

export async function validateReaderManagedPaths(
  config: ResolvedReaderConfig,
): Promise<void> {
  for (const target of [
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
    config.migrationsDir,
    config.reportsDir,
    config.dailyReportsDir,
    config.weeklyReportsDir,
    config.trendsReportsDir,
    config.surveyReportsDir,
    config.wikiDir,
  ]) {
    await assertNoSymlinkComponents(config.root, target);
  }
}

export async function assertNoSymlinkComponents(
  root: string,
  target: string,
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rootStat = await lstat(resolvedRoot);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Managed root is a symbolic link: ${resolvedRoot}`);
  }
  const relationship = path.relative(resolvedRoot, resolvedTarget);
  if (
    relationship === ".." ||
    relationship.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relationship)
  ) {
    throw new Error(`Managed path escapes Reader root: ${target}`);
  }
  const canonicalRoot = await realpath(resolvedRoot);
  let current = resolvedRoot;
  for (const segment of relationship.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const file = await lstat(current);
      if (file.isSymbolicLink()) {
        throw new Error(`Managed path contains a symbolic link: ${current}`);
      }
      const canonical = await realpath(current);
      if (!isContained(canonicalRoot, canonical)) {
        throw new Error(
          `Managed path resolves outside Reader root: ${current}`,
        );
      }
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }
}

export async function secureExistingPath(
  root: string,
  target: string,
): Promise<string> {
  await assertNoSymlinkComponents(root, target);
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    realpath(root),
    realpath(target),
  ]);
  if (!isContained(canonicalRoot, canonicalTarget)) {
    throw new Error(`Path resolves outside allowed root: ${target}`);
  }
  return canonicalTarget;
}

function isContained(root: string, target: string): boolean {
  const relationship = path.relative(root, target);
  return (
    relationship !== ".." &&
    !relationship.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relationship)
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
