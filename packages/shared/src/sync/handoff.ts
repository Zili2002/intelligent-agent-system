/**
 * Agent handoff - context preservation on exit
 *
 * When an agent is about to exit, this module:
 * 1. Saves a final state checkpoint
 * 2. Commits the state to Git
 * 3. Pushes state and knowledge base to remote
 * 4. Ensures the next agent can seamlessly resume
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import type { AgentState } from "../types/agent-state";
import { saveCheckpoint, loadState } from "./checkpoint";

/**
 * Prepare agent handoff on exit
 *
 * @param reason - Why the agent is exiting
 * @param finalUpdates - Final state updates before handoff
 * @param projectRoot - Project root directory
 */
export async function handoffAgent(
  reason: "completed" | "paused" | "error",
  finalUpdates: Partial<AgentState> = {},
  projectRoot: string = process.cwd()
): Promise<void> {
  console.log("\n🤝 Preparing handoff...\n");

  // 1. Save final checkpoint
  const state = loadState(projectRoot);
  if (!state) {
    console.warn("⚠️  No state to hand off");
    return;
  }

  await saveCheckpoint(
    {
      ...finalUpdates,
      session: {
        ...state.session,
        endedAt: new Date().toISOString(),
      },
      mission: {
        ...state.mission,
        status: reason === "completed" ? "completed" : "paused",
      },
    },
    projectRoot
  );

  // 2. Commit state to Git
  await commitState(reason, projectRoot);

  // 3. Push knowledge base if updated
  if (state.knowledge.wikiPath) {
    await pushWiki(state.knowledge.wikiPath);
  }

  console.log("\n✨ Handoff complete. Next agent can resume from this state.\n");
}

/**
 * Commit state file to Git and push
 */
async function commitState(
  reason: string,
  projectRoot: string
): Promise<void> {
  try {
    const hostname = os.hostname();
    const timestamp = new Date().toISOString();

    // Check if there are changes to commit
    const status = execSync("git status --porcelain .agent-state.json", {
      cwd: projectRoot,
      encoding: "utf-8",
    }).trim();

    if (!status) {
      console.log("No state changes to commit");
      return;
    }

    // Add and commit
    execSync("git add .agent-state.json", {
      cwd: projectRoot,
      stdio: "inherit",
    });

    execSync(
      `git commit -m "chore: agent handoff (${reason}) from ${hostname}\n\nTimestamp: ${timestamp}"`,
      { cwd: projectRoot, stdio: "inherit" }
    );

    // Push to remote
    execSync("git push origin main", {
      cwd: projectRoot,
      stdio: "inherit",
    });

    console.log("✅ State pushed to remote");
  } catch (error) {
    console.error(
      `⚠️  Failed to push state: ${(error as Error).message}`
    );
    console.log("State saved locally. Run 'git push' manually when ready.");
  }
}

/**
 * Push knowledge base updates to remote
 */
async function pushWiki(wikiPath: string): Promise<void> {
  const resolvedPath = path.resolve(wikiPath);

  if (!fs.existsSync(path.join(resolvedPath, ".git"))) {
    return;
  }

  try {
    // Check for changes
    const status = execSync("git status --porcelain", {
      cwd: resolvedPath,
      encoding: "utf-8",
    }).trim();

    if (!status) {
      console.log("No wiki changes to push");
      return;
    }

    const hostname = os.hostname();
    const timestamp = new Date().toISOString();

    // Add all changes
    execSync("git add .", {
      cwd: resolvedPath,
      stdio: "inherit",
    });

    // Commit
    execSync(
      `git commit -m "docs: wiki update from ${hostname}\n\nTimestamp: ${timestamp}"`,
      { cwd: resolvedPath, stdio: "inherit" }
    );

    // Push
    execSync("git push origin wiki", {
      cwd: resolvedPath,
      stdio: "inherit",
    });

    console.log("✅ Wiki pushed to remote");
  } catch (error) {
    console.error(
      `⚠️  Failed to push wiki: ${(error as Error).message}`
    );
  }
}

/**
 * Register process exit handlers for automatic handoff
 *
 * Call this early in your application to ensure handoff happens
 * even on unexpected exit (Ctrl+C, uncaught exceptions).
 */
export function registerExitHandlers(
  projectRoot: string = process.cwd()
): void {
  const cleanup = async (signal: string) => {
    console.log(`\n\nReceived ${signal}`);
    await handoffAgent("paused", {}, projectRoot);
    process.exit(0);
  };

  // Graceful shutdown signals
  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  // Uncaught errors
  process.on("uncaughtException", async (error) => {
    console.error("Uncaught exception:", error);
    await handoffAgent(
      "error",
      {
        context: {
          keyFindings: [],
          openQuestions: [],
          decisions: [],
          warnings: [`Fatal error: ${error.message}`],
        },
      },
      projectRoot
    );
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    console.error("Unhandled rejection:", reason);
    await handoffAgent(
      "error",
      {
        context: {
          keyFindings: [],
          openQuestions: [],
          decisions: [],
          warnings: [`Unhandled rejection: ${reason}`],
        },
      },
      projectRoot
    );
    process.exit(1);
  });
}
