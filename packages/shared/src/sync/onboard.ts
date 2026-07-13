/**
 * Explicit, branch-aware context onboarding.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AgentState, OnboardResult } from "../types/agent-state.js";
import { loadState, saveCheckpoint } from "./checkpoint.js";

export interface OnboardOptions {
  projectRoot?: string;
  pullCode?: boolean;
  pullWiki?: boolean;
  remote?: string;
  branch?: string;
  wikiRemote?: string;
  wikiBranch?: string;
}

export async function onboardAgent(
  optionsOrRoot: OnboardOptions | string = {},
): Promise<OnboardResult> {
  const options =
    typeof optionsOrRoot === "string"
      ? { projectRoot: optionsOrRoot }
      : optionsOrRoot;
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const warnings: string[] = [];
  const previousState = loadState(projectRoot);

  if (options.pullCode) {
    const remote = options.remote ?? previousState?.sync.gitRemote ?? "origin";
    const branch =
      options.branch ??
      previousState?.sync.gitBranch ??
      currentBranch(projectRoot);
    try {
      pullRepository(projectRoot, remote, branch);
    } catch (error) {
      warnings.push(errorMessage(error));
    }
  }

  let state = loadState(projectRoot);
  if (!state) {
    return {
      state: null,
      summary: null,
      isResume: false,
      warnings,
    };
  }

  if (options.pullCode && warnings.length === 0) {
    state = await saveCheckpoint(
      {
        sync: {
          gitRemote: options.remote ?? state.sync.gitRemote ?? "origin",
          gitBranch: options.branch ?? currentBranch(projectRoot),
          lastPullAt: new Date().toISOString(),
        },
      },
      projectRoot,
    );
  }

  if (options.pullWiki && state.knowledge.wikiPath) {
    const wikiPath = path.resolve(projectRoot, state.knowledge.wikiPath);
    if (!existsSync(path.join(wikiPath, ".git"))) {
      warnings.push(`Wiki path is not a Git repository: ${wikiPath}`);
    } else {
      const remote =
        options.wikiRemote ?? state.sync.wikiRemote ?? state.sync.gitRemote;
      const branch =
        options.wikiBranch ?? state.sync.wikiBranch ?? currentBranch(wikiPath);
      try {
        pullRepository(wikiPath, remote || "origin", branch);
        state = await saveCheckpoint(
          {
            sync: {
              wikiRemote: remote || "origin",
              wikiBranch: branch,
            },
            knowledge: {
              lastSyncCommit: currentCommit(wikiPath),
            },
          },
          projectRoot,
        );
      } catch (error) {
        warnings.push(errorMessage(error));
      }
    }
  }

  return {
    state,
    summary: generateContextSummary(state),
    isResume: state.mission.status === "active",
    warnings,
  };
}

function pullRepository(
  repository: string,
  remote: string,
  branch: string,
): void {
  if (!remote.trim() || !branch.trim()) {
    throw new Error(
      `Git remote and branch must be non-empty for ${repository}`,
    );
  }

  const changes = runGit(repository, ["status", "--porcelain"]);
  if (changes.trim()) {
    throw new Error(
      `Skipped Git pull because ${repository} has uncommitted changes`,
    );
  }

  runGit(repository, ["pull", "--ff-only", remote, branch], true);
}

function currentBranch(repository: string): string {
  const branch = runGit(repository, ["branch", "--show-current"]).trim();
  if (!branch) {
    throw new Error(`Cannot determine current Git branch for ${repository}`);
  }
  return branch;
}

function currentCommit(repository: string): string {
  return runGit(repository, ["rev-parse", "HEAD"]).trim();
}

function runGit(cwd: string, args: string[], inheritOutput = false): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: inheritOutput ? ["ignore", "inherit", "inherit"] : "pipe",
  }) as string;
}

function generateContextSummary(state: AgentState): string {
  const lines = [
    `**Last session**: ${state.device}`,
    `**Updated**: ${formatTimestamp(state.lastUpdated)}`,
    "",
    `**Mission**: ${state.mission.id || "none"} (${state.mission.status})`,
    `**Phase**: ${state.mission.progress.phase || "not set"}`,
    `**Completed tasks**: ${state.mission.progress.completedTasks.length}`,
  ];

  if (state.mission.budget.limit > 0) {
    lines.push(
      `**Budget**: ${state.mission.budget.spent.toFixed(2)} / ${state.mission.budget.limit} ${state.mission.budget.currency}`,
    );
  } else {
    lines.push("**Budget**: unlimited or not configured");
  }

  if (state.mission.progress.nextActions.length > 0) {
    lines.push("", "**Next actions**:");
    for (const action of state.mission.progress.nextActions) {
      lines.push(`- ${action}`);
    }
  }

  if (state.context.keyFindings.length > 0) {
    lines.push("", "**Key findings**:");
    for (const finding of state.context.keyFindings.slice(0, 5)) {
      lines.push(`- ${finding}`);
    }
  }

  if (state.context.warnings.length > 0) {
    lines.push("", "**Warnings**:");
    for (const warning of state.context.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join("\n");
}

function formatTimestamp(value: string): string {
  if (!value) {
    return "never";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
