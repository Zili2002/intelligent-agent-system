/**
 * Complete Orient -> Hypothesize -> Design -> Execute -> Analyze -> Reflect ->
 * Decide cycle with durable checkpoints.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isBudgetExhausted,
  recordExperiment,
  saveMissionState,
  updateMetric,
} from "../mission/manager.js";
import { designExperimentForMission } from "../reasoning/provider.js";
import { executeExperiment } from "../sandbox/executor.js";
import { assessExperimentSafety } from "../sandbox/safety.js";
import {
  experimentDirectory,
  loadExperiment,
  loadExperimentResult,
  saveExperiment,
} from "../experiment/store.js";
import type { AgentConfig } from "../types/config.js";
import type { Experiment, Hypothesis } from "../types/experiment.js";
import type { Decision, Reflection, Situation } from "../types/exploration.js";
import type { Mission } from "../types/mission.js";
import type { ExecutionResult } from "../types/sandbox.js";
import { analyzeExperiment } from "./analyze.js";
import { decideNextAction } from "./decide.js";
import { generateHypotheses } from "./hypothesize.js";
import { orientAnalysis } from "./orient.js";
import { reflectOnExperiment } from "./reflect.js";

export interface ExplorationCycleOptions {
  root?: string;
  execute?: boolean;
  approve?: boolean;
}

export interface ExplorationCycleResult {
  mission: Mission;
  situation: Situation;
  hypotheses: Hypothesis[];
  experiment?: Experiment;
  execution?: ExecutionResult;
  reflection?: Reflection;
  decision: Decision;
}

export async function runExplorationCycle(
  mission: Mission,
  config: AgentConfig,
  options: ExplorationCycleOptions = {},
): Promise<ExplorationCycleResult> {
  const root = options.root ?? process.cwd();
  const situation = await orientAnalysis(mission);

  if (isBudgetExhausted(mission, config.budget.alerts.stopAt)) {
    mission.status = "paused";
    const decision: Decision = {
      action: "pause",
      rationale: `Budget usage already meets the configured ${config.budget.alerts.stopAt}% stop threshold`,
    };
    mission.notes.push(decision.rationale);
    await saveMissionState(mission, root);
    return {
      mission,
      situation,
      hypotheses: [],
      decision,
    };
  }

  const hypotheses = generateHypotheses(mission, situation);
  const topHypothesis = hypotheses[0];

  if (!topHypothesis) {
    const decision: Decision = {
      action: "pause",
      rationale: "No testable hypothesis could be generated",
    };
    mission.status = "paused";
    mission.notes.push(decision.rationale);
    await saveMissionState(mission, root);
    return { mission, situation, hypotheses, decision };
  }

  const designOutcome = await designExperimentForMission(
    mission,
    topHypothesis,
    config,
  );
  const experiment = designOutcome.experiment;
  mission.budget.llmTokensUsed +=
    designOutcome.inputTokens + designOutcome.outputTokens;
  mission.budget.costSpent += designOutcome.estimatedCostUsd;
  const safety = assessExperimentSafety(experiment, mission, config);
  const designTokens = designOutcome.inputTokens + designOutcome.outputTokens;
  const tokenApprovalRequired =
    designTokens > config.budget.autoApprove.maxTokensPerExperiment;

  if (!safety.safe) {
    experiment.status = "failed";
    experiment.analysis = {
      success: false,
      hypothesisSupported: null,
      insights: [],
      unexpectedFindings: safety.violations,
      nextSteps: ["Revise the experiment so it passes the safety policy"],
      metricUpdates: {},
      measurements: {},
      knowledgeGaps: [],
    };
    await saveExperiment(experiment, root);
    mission.status = "paused";
    mission.notes.push(
      `Experiment ${experiment.id} was rejected: ${safety.violations.join("; ")}`,
    );
    await saveMissionState(mission, root);

    return {
      mission,
      situation,
      hypotheses,
      experiment,
      decision: {
        action: "pause",
        rationale: "Generated experiment failed the safety policy",
      },
    };
  }

  if (isBudgetExhausted(mission, config.budget.alerts.stopAt)) {
    experiment.status = "designed";
    await saveExperiment(experiment, root);
    mission.status = "paused";
    mission.notes.push(
      `Experiment ${experiment.id} was not executed because design usage reached the budget stop threshold`,
    );
    await saveMissionState(mission, root);
    return {
      mission,
      situation,
      hypotheses,
      experiment,
      decision: {
        action: "pause",
        rationale:
          "Design completed, but the mission budget stop threshold was reached",
      },
    };
  }

  if ((safety.requiresApproval || tokenApprovalRequired) && !options.approve) {
    experiment.status = "awaiting_approval";
    await saveExperiment(experiment, root);
    const approvalReasons = [
      ...safety.warnings,
      ...(mission.budget.approvalRequired
        ? ["Mission policy requires explicit approval"]
        : []),
      ...(!config.budget.autoApprove.enabled
        ? ["Automatic experiment approval is disabled"]
        : []),
      ...(tokenApprovalRequired
        ? [
            `Design used ${designTokens} tokens, above the ${config.budget.autoApprove.maxTokensPerExperiment}-token auto-approval limit`,
          ]
        : []),
    ];
    mission.notes.push(
      `Experiment ${experiment.id} awaits explicit approval: ${approvalReasons.join("; ")}`,
    );
    await saveMissionState(mission, root);

    return {
      mission,
      situation,
      hypotheses,
      experiment,
      decision: {
        action: "pause",
        rationale: `Experiment ${experiment.id} requires approval`,
      },
    };
  }

  experiment.status = "approved";
  experiment.approvedAt = new Date().toISOString();
  await saveExperiment(experiment, root);

  if (options.execute === false) {
    return {
      mission,
      situation,
      hypotheses,
      experiment,
      decision: {
        action: "pause",
        rationale:
          "Experiment was designed and approved but execution was disabled",
      },
    };
  }

  return executeApprovedExperiment(
    mission,
    experiment,
    config,
    root,
    situation,
    hypotheses,
  );
}

export async function resumeExperiment(
  mission: Mission,
  experimentId: string,
  config: AgentConfig,
  options: ExplorationCycleOptions = {},
): Promise<ExplorationCycleResult> {
  const root = options.root ?? process.cwd();
  const experiment = await loadExperiment(experimentId, root);
  if (experiment.missionId !== mission.id) {
    throw new Error(
      `Experiment ${experiment.id} belongs to ${experiment.missionId}, not ${mission.id}`,
    );
  }
  if (experiment.status === "completed") {
    throw new Error(`Experiment ${experiment.id} is already completed`);
  }

  const situation = await orientAnalysis(mission);
  const hypotheses = [experiment.hypothesis];
  const safety = assessExperimentSafety(experiment, mission, config);
  if (!safety.safe) {
    throw new Error(
      `Experiment ${experiment.id} failed safety validation: ${safety.violations.join("; ")}`,
    );
  }
  if (safety.requiresApproval && !options.approve) {
    experiment.status = "awaiting_approval";
    await saveExperiment(experiment, root);
    return {
      mission,
      situation,
      hypotheses,
      experiment,
      decision: {
        action: "pause",
        rationale: `Experiment ${experiment.id} requires approval`,
      },
    };
  }

  experiment.status = "approved";
  experiment.approvedAt = new Date().toISOString();
  await saveExperiment(experiment, root);
  return executeApprovedExperiment(
    mission,
    experiment,
    config,
    root,
    situation,
    hypotheses,
  );
}

async function executeApprovedExperiment(
  mission: Mission,
  experiment: Experiment,
  config: AgentConfig,
  root: string,
  situation: Situation,
  hypotheses: Hypothesis[],
): Promise<ExplorationCycleResult> {
  experiment.status = "running";
  experiment.execution = { startedAt: new Date().toISOString() };
  await saveExperiment(experiment, root);

  const directory = experimentDirectory(root, experiment.id);
  const execution = await executeExperiment(experiment, config, directory);
  experiment.execution = {
    ...experiment.execution,
    completedAt: new Date().toISOString(),
    exitCode: execution.exitCode,
    stdout: execution.stdout,
    stderr: execution.stderr,
    durationSeconds: execution.duration,
    metricsCollected: execution.resourceUsage,
  };
  mission.budget.computeHoursUsed += execution.duration / 3600;

  let resultDocument;
  try {
    resultDocument = await loadExperimentResult(experiment.id, root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    resultDocument = {
      status: "failed" as const,
      hypothesisSupported: null,
      findings: [],
      unexpectedFindings: [message],
      knowledgeGaps: [],
      nextSteps: ["Fix the experiment result contract and rerun"],
    };
  }

  experiment.analysis = analyzeExperiment(
    experiment,
    execution,
    resultDocument,
  );
  experiment.status = experiment.analysis.success ? "completed" : "failed";
  experiment.completedAt = new Date().toISOString();
  recordExperiment(mission, experiment.id);
  applyMetricUpdates(mission, experiment);

  const reflection = reflectOnExperiment(mission, experiment);
  mergeUnique(
    mission.findings,
    reflection.knowledgeExtracted.map((item) => item.insight),
  );
  mergeUnique(mission.knowledgeGaps, experiment.analysis.knowledgeGaps);
  mergeUnique(mission.notes, [
    ...reflection.whatWorked,
    ...reflection.whatDidntWork,
  ]);

  const decision = decideNextAction(mission, experiment, config);
  applyDecision(mission, decision);

  await writeFile(
    path.join(directory, "reflection.json"),
    `${JSON.stringify(reflection, null, 2)}\n`,
    "utf8",
  );
  await saveExperiment(experiment, root);
  await saveMissionState(mission, root);

  return {
    mission,
    situation,
    hypotheses,
    experiment,
    execution,
    reflection,
    decision,
  };
}

function applyMetricUpdates(mission: Mission, experiment: Experiment): void {
  if (!experiment.analysis) {
    return;
  }

  for (const [name, value] of Object.entries(
    experiment.analysis.metricUpdates,
  )) {
    try {
      updateMetric(mission, name, value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mergeUnique(mission.notes, [
        `Experiment ${experiment.id} reported an unusable metric update: ${message}`,
      ]);
    }
  }

  const completedMetric = mission.successMetrics.find(
    (metric) => metric.name.toLowerCase() === "experiments completed",
  );
  if (completedMetric) {
    updateMetric(
      mission,
      completedMetric.name,
      String(mission.experimentIds.length),
    );
  }
}

function applyDecision(mission: Mission, decision: Decision): void {
  switch (decision.action) {
    case "complete":
      mission.status = "completed";
      mission.completedAt = new Date().toISOString();
      break;
    case "pause":
      mission.status = "paused";
      break;
    case "continue":
    case "pivot":
      mission.status = "active";
      break;
  }
  mergeUnique(mission.notes, [decision.rationale]);
}

function mergeUnique(target: string[], values: string[]): void {
  const existing = new Set(target);
  for (const value of values) {
    const normalized = value.trim();
    if (normalized && !existing.has(normalized)) {
      target.push(normalized);
      existing.add(normalized);
    }
  }
}
