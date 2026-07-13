#!/usr/bin/env node
/**
 * CLI entry point for the autonomous agent system.
 */

import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import {
  handoffAgent,
  loadState,
  onboardAgent,
  saveCheckpoint,
} from "@intelligent-agent/shared";
import { resumeExperiment, runExplorationCycle } from "./exploration/cycle.js";
import { orientAnalysis } from "./exploration/orient.js";
import {
  calculateProgress,
  backupMissionState,
  loadMission,
  loadMissionForExecution,
  loadMissionStateIfExists,
  resumeMissionState,
  saveMissionState,
} from "./mission/manager.js";
import { syncExperimentToWiki, type WikiSyncResult } from "./knowledge/wiki.js";
import type { AgentConfig } from "./types/config.js";
import type { Mission } from "./types/mission.js";
import { initConfig, loadConfig } from "./utils/config.js";

const program = new Command();

program
  .name("autonomous-agent")
  .description("Mission-driven autonomous exploration system")
  .version("0.2.1")
  .option(
    "-r, --root <path>",
    "Agent workspace containing missions/ and experiments/",
    process.cwd(),
  );

program
  .command("init")
  .description("Initialize agent configuration and workspace directories")
  .action(
    command(async () => {
      const root = rootDirectory();
      await initConfig(root);
      const config = await loadConfig(root);
      await saveCheckpoint(
        {
          knowledge: {
            wikiPath: config.wikiPath ?? "",
          },
        },
        root,
      );
      console.log(`Initialized agent workspace: ${root}`);
    }),
  );

program
  .command("onboard")
  .description("Load local context and optionally pull clean Git repositories")
  .option("--pull", "Pull the agent repository with --ff-only")
  .option("--pull-wiki", "Pull the configured wiki repository with --ff-only")
  .action(
    command(async (options: { pull?: boolean; pullWiki?: boolean }) => {
      const result = await onboardAgent({
        projectRoot: rootDirectory(),
        pullCode: options.pull,
        pullWiki: options.pullWiki,
      });
      if (result.summary) {
        console.log(result.summary);
      } else {
        console.log("No previous agent state found.");
      }
      for (const warning of result.warnings) {
        console.warn(`Warning: ${warning}`);
      }
    }),
  );

program
  .command("mission-start")
  .description("Start or resume a mission from Markdown")
  .argument("<file>", "Mission Markdown file")
  .option("--reset", "Back up and reset existing state for this mission ID")
  .action(
    command(async (file: string, options: { reset?: boolean }) => {
      const root = rootDirectory();
      const config = await loadConfig(root);
      const definition = await loadMission(file, root);
      const existing = await loadMissionStateIfExists(definition.id, root);
      let mission = definition;
      let backupPath: string | undefined;
      if (existing && !options.reset) {
        mission = resumeMissionState(definition, existing);
      } else if (existing && options.reset) {
        backupPath = await backupMissionState(definition.id, root);
      }
      mission.status = "active";
      mission.startedAt ??= new Date().toISOString();
      mission.maxIterations = config.maxIterations;
      const statePath = await saveMissionState(mission, root);
      await checkpointMission(mission, config, root);

      console.log(`Mission started: ${mission.name}`);
      console.log(`ID: ${mission.id}`);
      console.log(`State: ${statePath}`);
      console.log(`Success metrics: ${mission.successMetrics.length}`);
      console.log(`Maximum iterations: ${mission.maxIterations}`);
      if (existing && !options.reset) {
        console.log("Resumed existing mission state.");
      }
      if (backupPath) {
        console.log(`Previous state backup: ${backupPath}`);
      }
    }),
  );

program
  .command("mission-status")
  .description("Show persisted mission status")
  .argument("<mission>", "Mission ID, state file, Markdown file, or path")
  .action(
    command(async (missionReference: string) => {
      const mission = await loadMission(missionReference, rootDirectory());
      printMissionStatus(mission);
    }),
  );

program
  .command("orient")
  .description("Analyze mission progress, opportunities, and risks")
  .argument("<mission>", "Mission ID, state file, Markdown file, or path")
  .action(
    command(async (missionReference: string) => {
      const mission = await loadMission(missionReference, rootDirectory());
      const situation = await orientAnalysis(mission);
      console.log(JSON.stringify(situation, null, 2));
    }),
  );

program
  .command("explore")
  .description("Run one complete exploration cycle")
  .argument("<mission>", "Mission ID, state file, Markdown file, or path")
  .option("--no-execute", "Design and checkpoint without executing")
  .option(
    "--approve",
    "Explicitly approve an experiment when policy requires it",
  )
  .option(
    "--sandbox <type>",
    "Override sandbox type: docker, local, or hybrid",
    parseSandboxType,
  )
  .option("--offline", "Force deterministic rule-based experiment design")
  .option(
    "--learn",
    "Allow active wiki gap search and evidence import for this cycle",
  )
  .action(
    command(
      async (
        missionReference: string,
        options: {
          execute: boolean;
          approve?: boolean;
          sandbox?: "docker" | "local" | "hybrid";
          offline?: boolean;
          learn?: boolean;
        },
      ) => {
        const root = rootDirectory();
        const mission = await prepareMission(missionReference, root);
        const config = await configuredAgent(root, options);
        const result = await runExplorationCycle(mission, config, {
          root,
          execute: options.execute,
          approve: options.approve,
        });
        const wiki = await syncCycleKnowledge(mission, config, root, result);
        await checkpointMission(mission, config, root, result, wiki);
        printCycleResult(result);
        printWikiResult(wiki);
      },
    ),
  );

program
  .command("run")
  .description("Run exploration cycles until completion, pause, or cycle limit")
  .argument("<mission>", "Mission ID, state file, Markdown file, or path")
  .option(
    "--max-cycles <count>",
    "Maximum cycles for this invocation",
    parsePositiveInteger,
  )
  .option("--approve", "Explicitly approve experiments when policy requires it")
  .option(
    "--sandbox <type>",
    "Override sandbox type: docker, local, or hybrid",
    parseSandboxType,
  )
  .option("--offline", "Force deterministic rule-based experiment design")
  .option(
    "--learn",
    "Allow active wiki gap search and evidence import during this run",
  )
  .action(
    command(
      async (
        missionReference: string,
        options: {
          maxCycles?: number;
          approve?: boolean;
          sandbox?: "docker" | "local" | "hybrid";
          offline?: boolean;
          learn?: boolean;
        },
      ) => {
        const root = rootDirectory();
        const mission = await prepareMission(missionReference, root);
        const config = await configuredAgent(root, options);
        const maxCycles = Math.min(
          options.maxCycles ?? config.maxIterations,
          mission.maxIterations,
        );

        for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
          console.log(`\nCycle ${cycle}/${maxCycles}`);
          const result = await runExplorationCycle(mission, config, {
            root,
            execute: true,
            approve: options.approve,
          });
          const wiki = await syncCycleKnowledge(mission, config, root, result);
          await checkpointMission(mission, config, root, result, wiki);
          printCycleResult(result);
          printWikiResult(wiki);

          if (
            result.decision.action !== "continue" &&
            result.decision.action !== "pivot"
          ) {
            break;
          }
        }

        printMissionStatus(mission);
      },
    ),
  );

program
  .command("experiment-resume")
  .description("Resume a checkpointed or approval-gated experiment")
  .argument("<mission>", "Mission ID, state file, Markdown file, or path")
  .argument("<experiment-id>", "Persisted experiment ID")
  .option("--approve", "Explicitly approve the experiment")
  .option(
    "--sandbox <type>",
    "Override sandbox type: docker, local, or hybrid",
    parseSandboxType,
  )
  .option(
    "--learn",
    "Allow active wiki gap search and evidence import after resuming",
  )
  .action(
    command(
      async (
        missionReference: string,
        experimentId: string,
        options: {
          approve?: boolean;
          sandbox?: "docker" | "local" | "hybrid";
          learn?: boolean;
        },
      ) => {
        const root = rootDirectory();
        const mission = await prepareMission(missionReference, root);
        const config = await configuredAgent(root, options);
        const result = await resumeExperiment(mission, experimentId, config, {
          root,
          approve: options.approve,
        });
        const wiki = await syncCycleKnowledge(mission, config, root, result);
        await checkpointMission(mission, config, root, result, wiki);
        printCycleResult(result);
        printWikiResult(wiki);
      },
    ),
  );

program
  .command("handoff")
  .description(
    "Checkpoint locally and optionally commit/push agent and wiki state",
  )
  .option(
    "--reason <reason>",
    "completed, paused, or error",
    parseHandoffReason,
    "paused",
  )
  .option("--commit", "Commit .agent-state.json")
  .option("--push", "Commit and push .agent-state.json")
  .option("--commit-wiki", "Commit all wiki repository changes")
  .option("--push-wiki", "Commit and push wiki repository changes")
  .action(
    command(
      async (options: {
        reason: "completed" | "paused" | "error";
        commit?: boolean;
        push?: boolean;
        commitWiki?: boolean;
        pushWiki?: boolean;
      }) => {
        const result = await handoffAgent(options.reason, {}, rootDirectory(), {
          commitState: options.commit || options.push,
          pushState: options.push,
          commitWiki: options.commitWiki || options.pushWiki,
          pushWiki: options.pushWiki,
        });
        console.log(
          JSON.stringify(
            {
              stateCommitted: result.stateCommitted,
              statePushed: result.statePushed,
              wikiCommitted: result.wikiCommitted,
              wikiPushed: result.wikiPushed,
            },
            null,
            2,
          ),
        );
      },
    ),
  );

await program.parseAsync();

function command<TArgs extends unknown[]>(
  action: (...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    try {
      await action(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exitCode = 1;
    }
  };
}

function rootDirectory(): string {
  return path.resolve(program.opts<{ root: string }>().root);
}

async function prepareMission(
  missionReference: string,
  root: string,
): Promise<Mission> {
  const mission = await loadMissionForExecution(missionReference, root);
  if (mission.status === "completed") {
    throw new Error(`Mission ${mission.id} is already completed`);
  }
  mission.status = "active";
  mission.startedAt ??= new Date().toISOString();
  await saveMissionState(mission, root);
  return mission;
}

async function configuredAgent(
  root: string,
  options: {
    sandbox?: "docker" | "local" | "hybrid";
    offline?: boolean;
    learn?: boolean;
  },
): Promise<AgentConfig> {
  const config = await loadConfig(root);
  if (options.sandbox) {
    config.sandbox.type = options.sandbox;
  }
  if (options.offline) {
    config.analysis.mode = "rule-based";
  }
  if (options.learn) {
    config.autoLearnWiki = true;
  }
  return config;
}

function printMissionStatus(mission: Mission): void {
  const progress = calculateProgress(mission);
  console.log(`\nMission: ${mission.name}`);
  console.log(`ID: ${mission.id}`);
  console.log(`Status: ${mission.status}`);
  console.log(
    `Metrics: ${progress.metricsAchieved}/${progress.metricsTotal} achieved`,
  );
  console.log(
    `Checkpoints: ${progress.checkpointsCompleted}/${progress.checkpointsTotal} completed`,
  );
  console.log(`Budget used: ${progress.budgetUsedPercent.toFixed(1)}%`);
  console.log(`Experiments: ${progress.experimentsCompleted}`);
  console.log(`Iteration: ${progress.iteration}/${mission.maxIterations}`);
}

function printCycleResult(
  result: Awaited<ReturnType<typeof runExplorationCycle>>,
): void {
  console.log(`Opportunities: ${result.situation.opportunities.length}`);
  console.log(`Risks: ${result.situation.risks.length}`);
  console.log(`Hypotheses: ${result.hypotheses.length}`);
  if (result.experiment) {
    console.log(`Experiment: ${result.experiment.id}`);
    console.log(`Experiment status: ${result.experiment.status}`);
  }
  if (result.execution) {
    console.log(`Exit code: ${result.execution.exitCode}`);
    console.log(`Duration: ${result.execution.duration.toFixed(3)}s`);
  }
  console.log(`Decision: ${result.decision.action}`);
  console.log(`Rationale: ${result.decision.rationale}`);
}

function printWikiResult(result?: WikiSyncResult): void {
  if (!result) {
    return;
  }
  console.log(
    `Wiki: ${result.status.sourceArtifacts} sources, ${result.status.wikiPages} pages`,
  );
  if (result.learning) {
    const errors = result.learning.searches.reduce(
      (count, search) => count + search.errors.length,
      0,
    );
    console.log(
      `Active learning: ${result.learning.selectedGaps.length} gaps, ${result.learning.imported} sources imported, ${errors} errors`,
    );
  }
}

async function syncCycleKnowledge(
  mission: Mission,
  config: AgentConfig,
  root: string,
  cycle: Awaited<ReturnType<typeof runExplorationCycle>>,
): Promise<WikiSyncResult | undefined> {
  if (!cycle.experiment || !cycle.reflection) {
    return undefined;
  }
  return syncExperimentToWiki(
    mission,
    cycle.experiment,
    cycle.reflection,
    config,
    root,
  );
}

async function checkpointMission(
  mission: Mission,
  config: AgentConfig,
  root: string,
  cycle?: Awaited<ReturnType<typeof runExplorationCycle>>,
  wiki?: WikiSyncResult,
): Promise<void> {
  const previous = loadState(root);
  const experiment = cycle?.experiment;
  const isNewExperiment =
    experiment !== undefined &&
    previous?.exploration.lastExperiment?.id !== experiment.id;
  const successfulExperiments =
    (previous?.exploration.successfulExperiments ?? 0) +
    (isNewExperiment && experiment.analysis?.success ? 1 : 0);
  const budgetUsesUsd = mission.budget.costLimit > 0;

  await saveCheckpoint(
    {
      mission: {
        id: mission.id,
        path: mission.sourcePath ?? "",
        status:
          mission.status === "completed"
            ? "completed"
            : mission.status === "active"
              ? "active"
              : "paused",
        progress: {
          phase: cycle?.decision.action ?? mission.status,
          completedTasks: mission.experimentIds,
          nextActions: cycle?.decision.nextHypotheses ?? [],
        },
        budget: {
          limit: budgetUsesUsd
            ? mission.budget.costLimit
            : mission.budget.llmTokens,
          spent: budgetUsesUsd
            ? mission.budget.costSpent
            : mission.budget.llmTokensUsed,
          currency: budgetUsesUsd ? "USD" : "tokens",
        },
      },
      knowledge: {
        wikiPath: config.wikiPath ?? previous?.knowledge.wikiPath ?? "",
        lastCompileAt:
          wiki !== undefined
            ? new Date().toISOString()
            : (previous?.knowledge.lastCompileAt ?? ""),
        sourceCount:
          wiki?.status.sourceArtifacts ?? previous?.knowledge.sourceCount ?? 0,
        pageCount: wiki?.status.wikiPages ?? previous?.knowledge.pageCount ?? 0,
      },
      exploration: {
        hypothesesGenerated:
          (previous?.exploration.hypothesesGenerated ?? 0) +
          (cycle?.hypotheses.length ?? 0),
        experimentsRun: mission.experimentIds.length,
        successfulExperiments,
        lastExperiment: experiment
          ? {
              id: experiment.id,
              description: experiment.design.description,
              result: experiment.analysis?.success
                ? "success"
                : experiment.analysis
                  ? "failure"
                  : "inconclusive",
              timestamp: experiment.updatedAt ?? experiment.createdAt,
            }
          : previous?.exploration.lastExperiment,
      },
      evolution: {
        lastReflectionAt:
          cycle?.reflection?.timestamp ??
          previous?.evolution.lastReflectionAt ??
          "",
        knowledgeGaps: mission.knowledgeGaps,
      },
      context: {
        keyFindings: mission.findings,
      },
    },
    root,
  );
}

function parsePositiveInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Expected a positive integer");
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Expected a positive integer");
  }
  return parsed;
}

function parseSandboxType(value: string): "docker" | "local" | "hybrid" {
  if (value === "docker" || value === "local" || value === "hybrid") {
    return value;
  }
  throw new InvalidArgumentError("Expected docker, local, or hybrid");
}

function parseHandoffReason(value: string): "completed" | "paused" | "error" {
  if (value === "completed" || value === "paused" || value === "error") {
    return value;
  }
  throw new InvalidArgumentError("Expected completed, paused, or error");
}
