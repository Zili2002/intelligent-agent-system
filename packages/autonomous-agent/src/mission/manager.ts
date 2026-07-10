/**
 * Mission manager - manages mission lifecycle and tracking.
 */

import { readFile, writeFile } from "fs/promises";
import path from "path";
import type { Mission, MissionProgress } from "../types/mission.js";
import { parseMission } from "./parser.js";

const MISSIONS_DIR = "missions";

/**
 * Load a mission from file.
 */
export async function loadMission(
  missionFile: string,
  root: string = process.cwd()
): Promise<Mission> {
  const filePath = path.join(root, MISSIONS_DIR, "active", missionFile);
  return parseMission(filePath);
}

/**
 * Save mission state to JSON.
 */
export async function saveMissionState(
  mission: Mission,
  root: string = process.cwd()
): Promise<void> {
  const stateFile = path.join(
    root,
    MISSIONS_DIR,
    "active",
    `${mission.id}.state.json`
  );
  await writeFile(stateFile, JSON.stringify(mission, null, 2));
}

/**
 * Calculate mission progress.
 */
export function calculateProgress(mission: Mission): MissionProgress {
  const metricsAchieved = mission.successMetrics.filter((m) => m.achieved).length;
  const metricsTotal = mission.successMetrics.length;

  const checkpointsCompleted = mission.checkpoints.filter(
    (c) => c.completed
  ).length;
  const checkpointsTotal = mission.checkpoints.length;

  const budgetUsed =
    mission.budget.llmTokensUsed / mission.budget.llmTokens +
    mission.budget.computeHoursUsed / mission.budget.computeHours;
  const budgetUsedPercent = Math.min(100, (budgetUsed / 2) * 100);

  const daysElapsed = mission.startedAt
    ? Math.floor(
        (Date.now() - new Date(mission.startedAt).getTime()) /
          (1000 * 60 * 60 * 24)
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
    daysElapsed,
  };
}

/**
 * Mark a checkpoint as completed.
 */
export function completeCheckpoint(
  mission: Mission,
  checkpointIndex: number
): Mission {
  if (checkpointIndex < mission.checkpoints.length) {
    mission.checkpoints[checkpointIndex].completed = true;
    mission.checkpoints[checkpointIndex].completedAt = new Date().toISOString();
  }
  return mission;
}

/**
 * Update a success metric.
 */
export function updateMetric(
  mission: Mission,
  metricName: string,
  currentValue: string
): Mission {
  const metric = mission.successMetrics.find((m) => m.name === metricName);
  if (metric) {
    metric.current = currentValue;
    // Simple heuristic: if current contains target, mark achieved
    metric.achieved = currentValue.includes(metric.target);
  }
  return mission;
}
