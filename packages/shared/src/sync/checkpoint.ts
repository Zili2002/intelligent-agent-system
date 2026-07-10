/**
 * State checkpoint - periodic saving of agent state
 *
 * Checkpoints are saved after key operations (e.g., completing a task,
 * running an experiment, compiling the wiki) to ensure context is preserved
 * for handoff to the next agent session.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { AgentState } from "../types/agent-state";

const STATE_FILE = ".agent-state.json";

/**
 * Save a checkpoint with state updates
 *
 * Merges the provided updates into the existing state and writes to disk.
 */
export async function saveCheckpoint(
  updates: Partial<AgentState>,
  projectRoot: string = process.cwd()
): Promise<void> {
  const statePath = path.join(projectRoot, STATE_FILE);

  let state: AgentState;

  if (fs.existsSync(statePath)) {
    const content = fs.readFileSync(statePath, "utf-8");
    state = JSON.parse(content);
  } else {
    state = createEmptyState();
  }

  // Merge updates
  state = deepMerge(state, updates);
  state.lastUpdated = new Date().toISOString();
  state.device = os.hostname();

  // Write to disk
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

  const timestamp = new Date().toLocaleTimeString();
  console.log(`✅ Checkpoint saved at ${timestamp}`);
}

/**
 * Wrap an operation with automatic checkpointing
 *
 * Usage:
 *   await withCheckpoint(
 *     async () => runExperiment(),
 *     { exploration: { experimentsRun: state.exploration.experimentsRun + 1 } }
 *   );
 */
export async function withCheckpoint<T>(
  operation: () => Promise<T>,
  stateUpdate: Partial<AgentState>,
  projectRoot: string = process.cwd()
): Promise<T> {
  const result = await operation();
  await saveCheckpoint(stateUpdate, projectRoot);
  return result;
}

/**
 * Create an empty state for new projects
 */
function createEmptyState(): AgentState {
  return {
    version: "1.0.0",
    lastUpdated: new Date().toISOString(),
    device: os.hostname(),

    session: {
      id: generateId(),
      startedAt: new Date().toISOString(),
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
      gitRemote: "",
      gitBranch: "main",
      lastPullAt: "",
      lastPushAt: "",
      conflicts: [],
    },
  };
}

/**
 * Deep merge two objects
 *
 * Arrays are concatenated, primitives are overwritten, objects are recursively merged.
 */
function deepMerge<T>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (sourceValue === undefined) {
      continue;
    }

    if (Array.isArray(sourceValue) && Array.isArray(targetValue)) {
      // Concatenate arrays (deduplicate strings)
      if (typeof sourceValue[0] === "string") {
        (result as any)[key] = [...new Set([...targetValue, ...sourceValue])];
      } else {
        (result as any)[key] = [...targetValue, ...sourceValue];
      }
    } else if (
      typeof sourceValue === "object" &&
      sourceValue !== null &&
      typeof targetValue === "object" &&
      targetValue !== null
    ) {
      // Recursively merge objects
      (result as any)[key] = deepMerge(targetValue, sourceValue);
    } else {
      // Overwrite primitives
      (result as any)[key] = sourceValue;
    }
  }

  return result;
}

/**
 * Generate a random ID for sessions
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Read current state snapshot
 */
export function loadState(projectRoot: string = process.cwd()): AgentState | null {
  const statePath = path.join(projectRoot, STATE_FILE);

  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(statePath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    console.error(`Failed to load state: ${(error as Error).message}`);
    return null;
  }
}
