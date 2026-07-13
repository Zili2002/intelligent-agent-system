/**
 * Atomic agent-state checkpoints.
 */

import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentState, DeepPartial } from "../types/agent-state.js";

const STATE_FILE = ".agent-state.json";
const LOCK_FILE = ".agent-state.lock";
const MERGED_ARRAY_PATHS = new Set([
  "context.keyFindings",
  "context.openQuestions",
  "context.decisions",
  "context.warnings",
  "evolution.knowledgeGaps",
  "evolution.proposedIdeas",
  "evolution.improvements",
  "sync.conflicts",
]);

export async function saveCheckpoint(
  updates: DeepPartial<AgentState>,
  projectRoot: string = process.cwd(),
): Promise<AgentState> {
  await mkdir(projectRoot, { recursive: true });
  return withStateLock(projectRoot, async () => {
    const statePath = path.join(projectRoot, STATE_FILE);
    const state = existsSync(statePath)
      ? parseState(await readFile(statePath, "utf8"), statePath)
      : createEmptyState();
    const merged = mergeValue(state, updates, "") as AgentState;
    merged.lastUpdated = new Date().toISOString();
    merged.device = os.hostname();

    await atomicWrite(statePath, `${JSON.stringify(merged, null, 2)}\n`);
    return merged;
  });
}

export async function withCheckpoint<T>(
  operation: () => Promise<T>,
  stateUpdate: DeepPartial<AgentState>,
  projectRoot: string = process.cwd(),
): Promise<T> {
  const result = await operation();
  await saveCheckpoint(stateUpdate, projectRoot);
  return result;
}

export function createEmptyState(): AgentState {
  const now = new Date().toISOString();
  return {
    version: "1.0.0",
    lastUpdated: now,
    device: os.hostname(),
    session: {
      id: generateId(),
      startedAt: now,
    },
    mission: {
      id: "",
      path: "",
      status: "paused",
      progress: {
        phase: "",
        completedTasks: [],
        nextActions: [],
      },
      budget: {
        limit: 0,
        spent: 0,
        currency: "USD",
      },
    },
    knowledge: {
      wikiPath: "",
      lastCompileAt: "",
      sourceCount: 0,
      pageCount: 0,
      lastSyncCommit: "",
    },
    exploration: {
      hypothesesGenerated: 0,
      experimentsRun: 0,
      successfulExperiments: 0,
    },
    evolution: {
      lastReflectionAt: "",
      knowledgeGaps: [],
      proposedIdeas: [],
      improvements: [],
    },
    context: {
      keyFindings: [],
      openQuestions: [],
      decisions: [],
      warnings: [],
    },
    sync: {
      gitRemote: "origin",
      gitBranch: "master",
      wikiRemote: "origin",
      wikiBranch: "master",
      lastPullAt: "",
      lastPushAt: "",
      conflicts: [],
    },
  };
}

export function loadState(
  projectRoot: string = process.cwd(),
): AgentState | null {
  const statePath = path.join(projectRoot, STATE_FILE);
  if (!existsSync(statePath)) {
    return null;
  }

  return parseState(readFileSync(statePath, "utf8"), statePath);
}

function parseState(content: string, statePath: string): AgentState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${statePath}: ${message}`);
  }

  if (!isRecord(parsed) || typeof parsed.version !== "string") {
    throw new Error(`Invalid agent state in ${statePath}`);
  }

  return normalizeState(parsed as unknown as AgentState);
}

function normalizeState(state: AgentState): AgentState {
  const empty = createEmptyState();
  return mergeValue(empty, state, "") as AgentState;
}

function mergeValue(
  target: unknown,
  source: unknown,
  keyPath: string,
): unknown {
  if (source === undefined) {
    return target;
  }

  if (Array.isArray(source)) {
    if (!Array.isArray(target) || !MERGED_ARRAY_PATHS.has(keyPath)) {
      return structuredClone(source);
    }
    return mergeUniqueArray(target, source);
  }

  if (isRecord(target) && isRecord(source)) {
    const result: Record<string, unknown> = { ...target };
    for (const [key, sourceValue] of Object.entries(source)) {
      const childPath = keyPath ? `${keyPath}.${key}` : key;
      result[key] = mergeValue(result[key], sourceValue, childPath);
    }
    return result;
  }

  return source;
}

function mergeUniqueArray(target: unknown[], source: unknown[]): unknown[] {
  const combined = [...target, ...source];
  const seen = new Set<string>();
  return combined.filter((value) => {
    const key = stableKey(value);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function stableKey(value: unknown): string {
  return typeof value === "string" ? `string:${value}` : JSON.stringify(value);
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}

async function withStateLock<T>(
  projectRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(projectRoot, LOCK_FILE);
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if (!isAlreadyExists(error) || attempt === 39) {
        throw error;
      }
      await removeStaleLock(lockPath);
      await delay(25);
    }
  }

  if (!handle) {
    throw new Error(`Unable to acquire state lock: ${lockPath}`);
  }
  await handle.writeFile(
    JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    "utf8",
  );

  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const metadata = await stat(lockPath);
    if (Date.now() - metadata.mtimeMs > 60_000) {
      await rm(lockPath, { force: true });
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    isRecord(error) && typeof error.code === "string" && error.code === "EEXIST"
  );
}

function isNotFound(error: unknown): boolean {
  return (
    isRecord(error) && typeof error.code === "string" && error.code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
