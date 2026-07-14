import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Mission } from "../types/mission.js";
import type {
  RunBudgetSnapshot,
  RunEvent,
  RunRecord,
  RunStatus,
} from "./types.js";

const RUNS_DIR = "runs";
const HISTORY_FILE = "history.jsonl";
const LOG_FILE = "agent.log.jsonl";

export function budgetSnapshot(mission: Mission): RunBudgetSnapshot {
  return {
    llmTokensUsed: mission.budget.llmTokensUsed,
    computeHoursUsed: mission.budget.computeHoursUsed,
    costSpent: mission.budget.costSpent,
  };
}

export async function createRunRecord(
  mission: Mission,
  root: string,
): Promise<RunRecord> {
  const timestamp = new Date().toISOString();
  const run: RunRecord = {
    version: 1,
    id: `run-${randomUUID()}`,
    missionId: mission.id,
    mode: "continuous",
    status: "running",
    startedAt: timestamp,
    updatedAt: timestamp,
    cycles: 0,
    attempts: 0,
    budgetBefore: budgetSnapshot(mission),
    budgetAfter: budgetSnapshot(mission),
  };
  await saveRunRecord(run, root);
  await appendRunEvent(root, {
    timestamp,
    runId: run.id,
    missionId: mission.id,
    type: "run_started",
    message: "Continuous mission run started",
  });
  return run;
}

export async function saveRunRecord(
  run: RunRecord,
  root: string,
): Promise<void> {
  const directory = path.join(root, RUNS_DIR);
  await mkdir(directory, { recursive: true });
  run.updatedAt = new Date().toISOString();
  const filePath = path.join(directory, `${run.id}.json`);
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

export async function finishRunRecord(
  run: RunRecord,
  mission: Mission,
  status: Exclude<RunStatus, "running">,
  root: string,
  error?: string,
): Promise<void> {
  run.status = status;
  run.completedAt = new Date().toISOString();
  run.budgetAfter = budgetSnapshot(mission);
  if (error) {
    run.error = redact(error);
  }
  await saveRunRecord(run, root);
  await appendRunEvent(root, {
    timestamp: run.completedAt,
    runId: run.id,
    missionId: run.missionId,
    type:
      status === "failed"
        ? "run_failed"
        : status === "stopped"
          ? "run_stopped"
          : "run_completed",
    message: error ? redact(error) : `Run finished with status ${status}`,
  });
}

export async function appendRunEvent(
  root: string,
  event: RunEvent,
): Promise<void> {
  const directory = path.join(root, RUNS_DIR);
  await mkdir(directory, { recursive: true });
  const sanitized: RunEvent = {
    ...event,
    message: redact(event.message),
    ...(event.details ? { details: sanitizeDetails(event.details) } : {}),
  };
  const line = `${JSON.stringify(sanitized)}\n`;
  await Promise.all([
    appendFile(path.join(directory, HISTORY_FILE), line, "utf8"),
    appendFile(path.join(directory, LOG_FILE), line, "utf8"),
  ]);
}

export async function listRunRecords(
  root: string,
  limit = 20,
): Promise<RunRecord[]> {
  const directory = path.join(root, RUNS_DIR);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const runs: RunRecord[] = [];
  for (const name of names.filter(
    (entry) => entry.startsWith("run-") && entry.endsWith(".json"),
  )) {
    const content = await readFile(path.join(directory, name), "utf8");
    runs.push(JSON.parse(content) as RunRecord);
  }
  return runs
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, Math.max(1, limit));
}

export async function readRunHistory(
  root: string,
  limit = 50,
): Promise<RunEvent[]> {
  const filePath = path.join(root, RUNS_DIR, HISTORY_FILE);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-Math.max(1, limit))
    .map((line) => JSON.parse(line) as RunEvent);
}

function redact(value: string): string {
  return value
    .replace(/\b(?:sk|api)[-_][A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(
      /(ANTHROPIC_(?:API_KEY|AUTH_TOKEN)\s*[=:]\s*)\S+/gi,
      "$1[REDACTED]",
    );
}

function sanitizeDetails(
  details: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      typeof value === "string" ? redact(value) : value,
    ]),
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
