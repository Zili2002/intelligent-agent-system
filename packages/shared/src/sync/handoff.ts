/**
 * Explicit context handoff.
 *
 * Checkpointing is always local. Git commits and pushes require opt-in flags.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AgentState, DeepPartial } from "../types/agent-state.js";
import { loadState, saveCheckpoint } from "./checkpoint.js";

export interface HandoffOptions {
  commitState?: boolean;
  pushState?: boolean;
  commitWiki?: boolean;
  pushWiki?: boolean;
  remote?: string;
  branch?: string;
  wikiRemote?: string;
  wikiBranch?: string;
}

export interface HandoffResult {
  state: AgentState;
  stateCommitted: boolean;
  statePushed: boolean;
  wikiCommitted: boolean;
  wikiPushed: boolean;
}

export async function handoffAgent(
  reason: "completed" | "paused" | "error",
  finalUpdates: DeepPartial<AgentState> = {},
  projectRoot: string = process.cwd(),
  options: HandoffOptions = {},
): Promise<HandoffResult> {
  if (options.pushState && !options.commitState) {
    throw new Error(
      "pushState requires commitState so state changes are durable",
    );
  }
  if (options.pushWiki && !options.commitWiki) {
    throw new Error("pushWiki requires commitWiki so wiki changes are durable");
  }

  const existing = loadState(projectRoot);
  if (!existing) {
    throw new Error(`No .agent-state.json exists in ${projectRoot}`);
  }

  let state = await saveCheckpoint(
    {
      ...finalUpdates,
      session: {
        ...existing.session,
        endedAt: new Date().toISOString(),
      },
      mission: {
        ...existing.mission,
        status: reason === "completed" ? "completed" : "paused",
      },
    },
    projectRoot,
  );

  let stateCommitted = false;
  let statePushed = false;
  let wikiCommitted = false;
  let wikiPushed = false;
  const remote = options.remote ?? state.sync.gitRemote ?? "origin";
  const branch =
    options.branch ?? state.sync.gitBranch ?? currentBranch(projectRoot);

  if (options.commitState) {
    stateCommitted = commitPaths(
      projectRoot,
      [".agent-state.json"],
      `chore: agent handoff (${reason}) from ${os.hostname()}`,
    );
  }

  if (options.pushState) {
    pushRepository(projectRoot, remote, branch);
    statePushed = true;
    state = await saveCheckpoint(
      {
        sync: {
          gitRemote: remote,
          gitBranch: branch,
          lastPushAt: new Date().toISOString(),
        },
      },
      projectRoot,
    );
    commitPaths(
      projectRoot,
      [".agent-state.json"],
      "chore: record successful agent state push",
    );
    pushRepository(projectRoot, remote, branch);
  }

  if (state.knowledge.wikiPath) {
    const wikiPath = path.resolve(projectRoot, state.knowledge.wikiPath);
    if (
      (options.commitWiki || options.pushWiki) &&
      !existsSync(path.join(wikiPath, ".git"))
    ) {
      throw new Error(`Wiki path is not a Git repository: ${wikiPath}`);
    }

    if (options.commitWiki) {
      wikiCommitted = commitPaths(
        wikiPath,
        ["--all"],
        `docs: wiki handoff from ${os.hostname()}`,
      );
    }

    if (options.pushWiki) {
      const wikiRemote =
        options.wikiRemote ?? state.sync.wikiRemote ?? "origin";
      const wikiBranch =
        options.wikiBranch ?? state.sync.wikiBranch ?? currentBranch(wikiPath);
      pushRepository(wikiPath, wikiRemote, wikiBranch);
      wikiPushed = true;
      state = await saveCheckpoint(
        {
          sync: {
            wikiRemote,
            wikiBranch,
          },
          knowledge: {
            lastSyncCommit: currentCommit(wikiPath),
          },
        },
        projectRoot,
      );

      if (options.commitState) {
        const metadataCommitted = commitPaths(
          projectRoot,
          [".agent-state.json"],
          "chore: record wiki synchronization metadata",
        );
        stateCommitted = stateCommitted || metadataCommitted;
        if (options.pushState && metadataCommitted) {
          pushRepository(projectRoot, remote, branch);
        }
      }
    }
  }

  return {
    state,
    stateCommitted,
    statePushed,
    wikiCommitted,
    wikiPushed,
  };
}

export function registerExitHandlers(
  projectRoot: string = process.cwd(),
  options: HandoffOptions = {},
): () => void {
  let handling = false;

  const cleanup = async (signal: string) => {
    if (handling) {
      return;
    }
    handling = true;
    try {
      await handoffAgent(
        "paused",
        {
          context: {
            warnings: [`Session ended after ${signal}`],
          },
        },
        projectRoot,
        options,
      );
      process.exit(0);
    } catch (error) {
      console.error(
        `Failed to checkpoint during ${signal}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exit(1);
    }
  };

  const onSigint = () => {
    void cleanup("SIGINT");
  };
  const onSigterm = () => {
    void cleanup("SIGTERM");
  };

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

function commitPaths(
  repository: string,
  paths: string[],
  message: string,
): boolean {
  const status = runGit(repository, ["status", "--porcelain"]).trim();
  if (!status) {
    return false;
  }

  runGit(repository, ["add", ...paths], true);
  const staged = runGit(repository, ["diff", "--cached", "--name-only"]).trim();
  if (!staged) {
    return false;
  }
  runGit(repository, ["commit", "-m", message], true);
  return true;
}

function pushRepository(
  repository: string,
  remote: string,
  branch: string,
): void {
  if (!remote.trim() || !branch.trim()) {
    throw new Error(
      `Git remote and branch must be non-empty for ${repository}`,
    );
  }
  runGit(repository, ["push", remote, branch], true);
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
