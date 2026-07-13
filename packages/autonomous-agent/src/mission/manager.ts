/**
 * Mission lifecycle and persistence.
 */

import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Budget,
  Mission,
  MissionProgress,
  SuccessMetric,
} from "../types/mission.js";
import { parseMission } from "./parser.js";

const MISSIONS_DIR = "missions";

/**
 * Load a mission Markdown definition or persisted JSON state.
 */
export async function loadMission(
  missionReference: string,
  root: string = process.cwd(),
): Promise<Mission> {
  const filePath = await resolveMissionPath(missionReference, root);

  if (filePath.toLowerCase().endsWith(".json")) {
    const content = await readFile(filePath, "utf8");
    return normalizeMission(JSON.parse(content) as Partial<Mission>, filePath);
  }

  return parseMission(filePath);
}

/**
 * Save mission state atomically.
 */
export async function saveMissionState(
  mission: Mission,
  root: string = process.cwd(),
): Promise<string> {
  const activeDir = path.join(root, MISSIONS_DIR, "active");
  await mkdir(activeDir, { recursive: true });

  mission.updatedAt = new Date().toISOString();
  const stateFile = path.join(activeDir, `${mission.id}.state.json`);
  const temporaryFile = `${stateFile}.${process.pid}.tmp`;
  await writeFile(
    temporaryFile,
    `${JSON.stringify(mission, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryFile, stateFile);
  return stateFile;
}

/**
 * Resolve a mission ID, state filename, Markdown filename, or direct path.
 */
export async function resolveMissionPath(
  missionReference: string,
  root: string = process.cwd(),
): Promise<string> {
  const references = new Set<string>();
  const direct = path.resolve(root, missionReference);
  references.add(direct);
  references.add(path.join(root, MISSIONS_DIR, "active", missionReference));

  if (!path.extname(missionReference)) {
    references.add(
      path.join(root, MISSIONS_DIR, "active", `${missionReference}.state.json`),
    );
    references.add(
      path.join(root, MISSIONS_DIR, "active", `${missionReference}.md`),
    );
  }

  for (const candidate of references) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the explicit candidate list.
    }
  }

  throw new Error(
    `Mission not found: ${missionReference}. Checked ${[...references].join(", ")}`,
  );
}

/**
 * Calculate mission progress without division-by-zero or unlimited-budget bugs.
 */
export function calculateProgress(mission: Mission): MissionProgress {
  const metricsAchieved = mission.successMetrics.filter(
    (metric) => metric.achieved,
  ).length;
  const metricsTotal = mission.successMetrics.length;
  const checkpointsCompleted = mission.checkpoints.filter(
    (checkpoint) => checkpoint.completed,
  ).length;
  const checkpointsTotal = mission.checkpoints.length;
  const budgetUsedPercent = calculateBudgetUsedPercent(mission.budget);
  const daysElapsed = mission.startedAt
    ? Math.max(
        0,
        Math.floor(
          (Date.now() - new Date(mission.startedAt).getTime()) /
            (1000 * 60 * 60 * 24),
        ),
      )
    : 0;

  return {
    missionId: mission.id,
    status: mission.status,
    metricsAchieved,
    metricsTotal,
    checkpointsCompleted,
    checkpointsTotal,
    budgetUsedPercent,
    experimentsCompleted: mission.experimentIds.length,
    iteration: mission.iteration,
    daysElapsed,
  };
}

export function calculateBudgetUsedPercent(budget: Budget): number {
  const percentages: number[] = [];

  if (budget.llmTokens > 0) {
    percentages.push(budget.llmTokensUsed / budget.llmTokens);
  }
  if (budget.computeHours > 0) {
    percentages.push(budget.computeHoursUsed / budget.computeHours);
  }
  if (budget.costLimit > 0) {
    percentages.push(budget.costSpent / budget.costLimit);
  }

  return percentages.length === 0
    ? 0
    : Math.min(100, Math.max(...percentages) * 100);
}

export function isBudgetExhausted(mission: Mission, stopAt = 100): boolean {
  return calculateBudgetUsedPercent(mission.budget) >= stopAt;
}

export function completeCheckpoint(
  mission: Mission,
  checkpointIndex: number,
): Mission {
  const checkpoint = mission.checkpoints[checkpointIndex];
  if (!checkpoint) {
    throw new Error(`Checkpoint index out of range: ${checkpointIndex}`);
  }

  checkpoint.completed = true;
  checkpoint.completedAt = new Date().toISOString();
  return mission;
}

export function updateMetric(
  mission: Mission,
  metricName: string,
  currentValue: string,
): Mission {
  const metric = mission.successMetrics.find(
    (candidate) => candidate.name.toLowerCase() === metricName.toLowerCase(),
  );
  if (!metric) {
    throw new Error(`Unknown success metric: ${metricName}`);
  }

  metric.current = currentValue;
  metric.achieved = evaluateMetric(metric, currentValue);
  return mission;
}

export function recordExperiment(
  mission: Mission,
  experimentId: string,
): Mission {
  if (!mission.experimentIds.includes(experimentId)) {
    mission.experimentIds.push(experimentId);
    mission.iteration += 1;
  }
  return mission;
}

function evaluateMetric(metric: SuccessMetric, currentValue: string): boolean {
  const targetComparison = parseComparison(metric.target);
  const currentNumber = extractNumber(currentValue);

  if (targetComparison && currentNumber !== undefined) {
    switch (targetComparison.operator) {
      case ">=":
        return currentNumber >= targetComparison.value;
      case "<=":
        return currentNumber <= targetComparison.value;
      case ">":
        return currentNumber > targetComparison.value;
      case "<":
        return currentNumber < targetComparison.value;
      case "=":
        return currentNumber === targetComparison.value;
    }
  }

  return (
    currentValue.trim().toLowerCase() === metric.target.trim().toLowerCase()
  );
}

function parseComparison(
  target: string,
): { operator: ">=" | "<=" | ">" | "<" | "="; value: number } | undefined {
  const normalized = target.replace(/≥/g, ">=").replace(/≤/g, "<=");
  const match = normalized.match(/(>=|<=|>|<|=)?\s*(-?[\d,.]+)/);
  if (!match) {
    return undefined;
  }

  return {
    operator: (match[1] || "=") as ">=" | "<=" | ">" | "<" | "=",
    value: Number(match[2].replace(/,/g, "")),
  };
}

function extractNumber(value: string): number | undefined {
  const match = value.match(/-?[\d,.]+/);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeMission(
  mission: Partial<Mission>,
  sourcePath: string,
): Mission {
  if (!mission.id || !mission.name || !mission.objective) {
    throw new Error(`Invalid mission state: ${sourcePath}`);
  }

  const now = new Date().toISOString();
  return {
    id: mission.id,
    name: mission.name,
    objective: mission.objective,
    sourcePath: mission.sourcePath,
    status: mission.status ?? "pending",
    priority: mission.priority ?? "medium",
    constraints: mission.constraints ?? [],
    successMetrics: mission.successMetrics ?? [],
    checkpoints: mission.checkpoints ?? [],
    budget: {
      llmTokens: mission.budget?.llmTokens ?? 0,
      llmTokensUsed: mission.budget?.llmTokensUsed ?? 0,
      computeHours: mission.budget?.computeHours ?? 0,
      computeHoursUsed: mission.budget?.computeHoursUsed ?? 0,
      costLimit: mission.budget?.costLimit ?? 0,
      costSpent: mission.budget?.costSpent ?? 0,
      currency: "USD",
      approvalRequired: mission.budget?.approvalRequired ?? false,
    },
    createdAt: mission.createdAt ?? now,
    updatedAt: mission.updatedAt ?? mission.createdAt ?? now,
    startedAt: mission.startedAt,
    completedAt: mission.completedAt,
    experimentIds: mission.experimentIds ?? [],
    notes: mission.notes ?? [],
    findings: mission.findings ?? [],
    knowledgeGaps: mission.knowledgeGaps ?? [],
    iteration: mission.iteration ?? mission.experimentIds?.length ?? 0,
    maxIterations: mission.maxIterations ?? 10,
  };
}
