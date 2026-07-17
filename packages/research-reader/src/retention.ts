import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, readJsonIfExists } from "@intelligent-agent/shared";
import { loadPaperPassport } from "./store.js";
import type { RetentionCheck, ResolvedReaderConfig } from "./types.js";

export async function createRetentionCheck(
  config: ResolvedReaderConfig,
  paperId: string,
  questions: string[],
  options: { dueAt?: Date; now?: Date } = {},
): Promise<RetentionCheck> {
  if (!(await loadPaperPassport(config, paperId))) {
    throw new Error(`Paper not found: ${paperId}`);
  }
  const normalized = questions
    .map((question) => question.trim())
    .filter(Boolean);
  if (!normalized.length) {
    throw new Error("Retention Check requires at least one question");
  }
  if (normalized.length > 50) {
    throw new Error("Retention Check supports at most 50 questions");
  }
  const now = options.now ?? new Date();
  const check: RetentionCheck = {
    version: 1,
    id: `retention-${randomUUID()}`,
    paperId,
    status: "pending",
    dueAt: (
      options.dueAt ?? new Date(now.getTime() + 7 * 86_400_000)
    ).toISOString(),
    items: normalized.map((question) => ({ question })),
    createdAt: now.toISOString(),
  };
  await atomicWriteJson(retentionPath(config, check.id), check);
  return check;
}

export async function completeRetentionCheck(
  config: ResolvedReaderConfig,
  checkId: string,
  selfScores: number[],
  now = new Date(),
): Promise<RetentionCheck> {
  const check = await readJsonIfExists(
    retentionPath(config, checkId),
    parseRetentionCheck,
  );
  if (!check) throw new Error(`Retention Check not found: ${checkId}`);
  if (check.status === "completed") {
    throw new Error(`Retention Check is already completed: ${checkId}`);
  }
  if (selfScores.length !== check.items.length) {
    throw new Error("Retention self-score count must match the question count");
  }
  selfScores.forEach((score) => {
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error("Retention self-scores must be from 0 to 1");
    }
  });
  check.items.forEach((item, index) => {
    item.selfScore = selfScores[index]!;
  });
  check.score =
    selfScores.reduce((total, value) => total + value, 0) / selfScores.length;
  check.status = "completed";
  check.completedAt = now.toISOString();
  await atomicWriteJson(retentionPath(config, check.id), check);
  return check;
}

export async function listRetentionChecks(
  config: ResolvedReaderConfig,
): Promise<RetentionCheck[]> {
  let names: string[];
  try {
    names = await readdir(config.retentionDir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const checks: RetentionCheck[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const check = await readJsonIfExists(
      path.join(config.retentionDir, name),
      parseRetentionCheck,
    );
    if (check) checks.push(check);
  }
  return checks.sort((left, right) => left.dueAt.localeCompare(right.dueAt));
}

function retentionPath(config: ResolvedReaderConfig, checkId: string): string {
  if (!/^retention-[A-Za-z0-9-]+$/.test(checkId)) {
    throw new Error(`Invalid Retention Check ID: ${checkId}`);
  }
  return path.join(config.retentionDir, `${checkId}.json`);
}

function parseRetentionCheck(value: unknown): RetentionCheck {
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
    !("status" in value) ||
    (value.status !== "pending" && value.status !== "completed") ||
    !("items" in value) ||
    !Array.isArray(value.items)
  ) {
    throw new Error("Invalid Retention Check");
  }
  return value as RetentionCheck;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
