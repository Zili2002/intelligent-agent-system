/**
 * Orient engine - analyzes current situation and identifies opportunities/risks.
 */

import type { Mission } from "../types/mission.js";
import type { Situation } from "../types/exploration.js";
import { calculateProgress } from "../mission/manager.js";

/**
 * Analyze the current situation for a mission.
 */
export async function orientAnalysis(mission: Mission): Promise<Situation> {
  const progress = calculateProgress(mission);
  const timestamp = new Date().toISOString();

  const knowledgeGaps = identifyKnowledgeGaps(mission);
  const opportunities = identifyOpportunities(mission, progress);
  const risks = assessRisks(mission, progress);
  const recommendations = generateRecommendations(
    mission,
    opportunities,
    risks,
  );

  return {
    missionId: mission.id,
    timestamp,
    currentState: {
      progress:
        progress.metricsTotal === 0
          ? 0
          : progress.metricsAchieved / progress.metricsTotal,
      metricsAchieved: progress.metricsAchieved,
      experimentsCompleted: progress.experimentsCompleted,
      knowledgeGaps,
    },
    opportunities,
    risks,
    recommendations,
  };
}

function identifyKnowledgeGaps(mission: Mission): string[] {
  const gaps: string[] = [];

  if (mission.experimentIds.length === 0) {
    gaps.push("No experiments conducted yet");
  }

  const unachievedMetrics = mission.successMetrics.filter((m) => !m.achieved);
  if (unachievedMetrics.length > 0) {
    gaps.push(
      `Missing knowledge to achieve ${unachievedMetrics.length} metric(s)`,
    );
  }

  return gaps;
}

function identifyOpportunities(
  mission: Mission,
  progress: ReturnType<typeof calculateProgress>,
): Situation["opportunities"] {
  const opportunities: Situation["opportunities"] = [];

  if (progress.experimentsCompleted === 0) {
    opportunities.push({
      description: "Fresh start - design exploratory baseline experiments",
      priority: "high",
      estimatedImpact: "Establish foundation for all future work",
    });
  }

  if (progress.budgetUsedPercent < 50 && progress.metricsAchieved < 2) {
    opportunities.push({
      description: "Plenty of budget remaining - try bold experiments",
      priority: "medium",
      estimatedImpact: "Accelerate progress with parallel approaches",
    });
  }

  const nextCheckpoint = mission.checkpoints.find((c) => !c.completed);
  if (nextCheckpoint) {
    opportunities.push({
      description: `Next checkpoint due: ${nextCheckpoint.date}`,
      priority: "high",
      estimatedImpact: nextCheckpoint.description,
    });
  }

  return opportunities;
}

function assessRisks(
  mission: Mission,
  progress: ReturnType<typeof calculateProgress>,
): Situation["risks"] {
  const risks: Situation["risks"] = [];

  if (progress.budgetUsedPercent > 80 && progress.metricsAchieved < 2) {
    risks.push({
      description: "Budget nearly exhausted with minimal progress",
      severity: "high",
      mitigation: "Focus on highest-impact experiments only",
    });
  }

  if (progress.daysElapsed > 7 && progress.experimentsCompleted === 0) {
    risks.push({
      description: "Week elapsed with no experiments",
      severity: "medium",
      mitigation: "Start with simple baseline experiment immediately",
    });
  }

  return risks;
}

function generateRecommendations(
  mission: Mission,
  opportunities: Situation["opportunities"],
  risks: Situation["risks"],
): string[] {
  const recommendations: string[] = [];

  const highRisks = risks.filter((r) => r.severity === "high");
  if (highRisks.length > 0) {
    recommendations.push(`Address ${highRisks.length} high-severity risk(s)`);
  }

  if (mission.experimentIds.length === 0) {
    recommendations.push("Design and execute baseline experiment");
  }

  const unachievedMetrics = mission.successMetrics.filter((m) => !m.achieved);
  if (unachievedMetrics.length > 0) {
    recommendations.push(`Focus on achieving: ${unachievedMetrics[0].name}`);
  }

  return recommendations;
}
