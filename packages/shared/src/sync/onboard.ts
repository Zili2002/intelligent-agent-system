/**
 * Agent onboarding - context synchronization on startup
 *
 * When an agent starts on a new device or after a break, this module:
 * 1. Pulls latest code and state from Git
 * 2. Loads the state snapshot
 * 3. Syncs the knowledge base
 * 4. Generates a human-readable context summary
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import type { AgentState, OnboardResult } from "../types/agent-state";

const STATE_FILE = ".agent-state.json";

/**
 * Main onboarding flow
 *
 * Call this at agent startup to sync context from the repository.
 */
export async function onboardAgent(
  projectRoot: string = process.cwd()
): Promise<OnboardResult> {
  console.log("🔄 Syncing context from repository...\n");

  // 1. Pull latest code
  await pullLatestCode(projectRoot);

  // 2. Load state snapshot
  const state = loadStateSnapshot(projectRoot);

  if (state) {
    console.log(
      `📋 Loaded state from ${state.device} (${formatTimestamp(state.lastUpdated)})\n`
    );
  } else {
    console.log("📋 No previous state found. Starting fresh.\n");
  }

  // 3. Sync knowledge base if it exists
  if (state?.knowledge.wikiPath) {
    await syncWiki(state.knowledge.wikiPath);
  }

  // 4. Generate context summary
  const summary = state ? await generateContextSummary(state) : null;

  return {
    state,
    summary,
    isResume: state?.mission.status === "active",
  };
}

/**
 * Pull latest code from Git remote
 */
async function pullLatestCode(cwd: string): Promise<void> {
  try {
    console.log("📥 Pulling latest code...");
    execSync("git pull --rebase origin main", { cwd, stdio: "inherit" });
    console.log();
  } catch (error) {
    console.warn(
      "⚠️  Git pull failed. Working with local state.\n"
    );
  }
}

/**
 * Load state snapshot from .agent-state.json
 */
function loadStateSnapshot(projectRoot: string): AgentState | null {
  const statePath = path.join(projectRoot, STATE_FILE);

  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(statePath, "utf-8");
    return JSON.parse(content) as AgentState;
  } catch (error) {
    console.error(
      `⚠️  Failed to parse state file: ${(error as Error).message}`
    );
    return null;
  }
}

/**
 * Sync knowledge base from its Git remote
 */
async function syncWiki(wikiPath: string): Promise<void> {
  const resolvedPath = path.resolve(wikiPath);

  if (!fs.existsSync(path.join(resolvedPath, ".git"))) {
    console.warn(`⚠️  Wiki path ${wikiPath} is not a Git repository\n`);
    return;
  }

  try {
    console.log("📚 Syncing knowledge base...");
    execSync("git pull --rebase origin wiki", {
      cwd: resolvedPath,
      stdio: "inherit",
    });
    console.log();
  } catch (error) {
    console.error(
      `⚠️  Failed to sync wiki: ${(error as Error).message}\n`
    );
  }
}

/**
 * Generate a human-readable context summary
 *
 * This uses an LLM to summarize the state snapshot for quick onboarding.
 * In a real implementation, this would call the Anthropic API.
 * For now, we generate a basic summary from the state object.
 */
async function generateContextSummary(state: AgentState): Promise<string> {
  const lines: string[] = [];

  // Session info
  lines.push(`**Last session**: ${state.device}`);
  lines.push(`**Updated**: ${formatTimestamp(state.lastUpdated)}`);
  lines.push("");

  // Mission status
  if (state.mission.status === "active") {
    lines.push(`**Mission**: ${state.mission.id} (${state.mission.status})`);
    lines.push(`**Phase**: ${state.mission.progress.phase}`);
    lines.push(
      `**Completed tasks**: ${state.mission.progress.completedTasks.length}`
    );
    lines.push(
      `**Budget**: $${state.mission.budget.spent.toFixed(2)} / $${state.mission.budget.limit} (${((state.mission.budget.spent / state.mission.budget.limit) * 100).toFixed(0)}%)`
    );
    lines.push("");
  }

  // Next actions
  if (state.mission.progress.nextActions.length > 0) {
    lines.push(`**Next actions**:`);
    state.mission.progress.nextActions.forEach((action) => {
      lines.push(`  - ${action}`);
    });
    lines.push("");
  }

  // Exploration progress
  if (state.exploration.experimentsRun > 0) {
    lines.push(`**Exploration**:`);
    lines.push(`  - Hypotheses generated: ${state.exploration.hypothesesGenerated}`);
    lines.push(`  - Experiments run: ${state.exploration.experimentsRun}`);
    lines.push(`  - Successful: ${state.exploration.successfulExperiments}`);
    if (state.exploration.lastExperiment) {
      lines.push(
        `  - Last: ${state.exploration.lastExperiment.description} (${state.exploration.lastExperiment.result})`
      );
    }
    lines.push("");
  }

  // Knowledge base
  lines.push(`**Knowledge base**:`);
  lines.push(`  - Sources: ${state.knowledge.sourceCount}`);
  lines.push(`  - Pages: ${state.knowledge.pageCount}`);
  lines.push(`  - Last compile: ${formatTimestamp(state.knowledge.lastCompileAt)}`);
  lines.push("");

  // Key findings
  if (state.context.keyFindings.length > 0) {
    lines.push(`**Key findings**:`);
    state.context.keyFindings.slice(0, 5).forEach((finding) => {
      lines.push(`  - ${finding}`);
    });
    if (state.context.keyFindings.length > 5) {
      lines.push(`  - ... and ${state.context.keyFindings.length - 5} more`);
    }
    lines.push("");
  }

  // Open questions
  if (state.context.openQuestions.length > 0) {
    lines.push(`**Open questions**:`);
    state.context.openQuestions.slice(0, 3).forEach((question) => {
      lines.push(`  - ${question}`);
    });
    if (state.context.openQuestions.length > 3) {
      lines.push(`  - ... and ${state.context.openQuestions.length - 3} more`);
    }
    lines.push("");
  }

  // Warnings
  if (state.context.warnings.length > 0) {
    lines.push(`**⚠️  Warnings**:`);
    state.context.warnings.forEach((warning) => {
      lines.push(`  - ${warning}`);
    });
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format ISO timestamp to human-readable form
 */
function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 7) {
    return date.toLocaleDateString();
  } else if (diffDays > 0) {
    return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
  } else if (diffHours > 0) {
    return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  } else if (diffMins > 0) {
    return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
  } else {
    return "just now";
  }
}
