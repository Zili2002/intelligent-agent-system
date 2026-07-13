/**
 * Decide the next mission action from verified state.
 */

import { calculateProgress, isBudgetExhausted } from "../mission/manager.js";
import type { Experiment } from "../types/experiment.js";
import type { Decision } from "../types/exploration.js";
import type { AgentConfig } from "../types/config.js";
import type { Mission } from "../types/mission.js";

export function decideNextAction(
  mission: Mission,
  experiment: Experiment,
  config: AgentConfig,
): Decision {
  const progress = calculateProgress(mission);

  if (
    progress.metricsTotal > 0 &&
    progress.metricsAchieved === progress.metricsTotal
  ) {
    return {
      action: "complete",
      rationale: "All declared success metrics are achieved",
    };
  }

  if (isBudgetExhausted(mission, config.budget.alerts.stopAt)) {
    return {
      action: "pause",
      rationale: `Budget usage reached the configured ${config.budget.alerts.stopAt}% stop threshold`,
    };
  }

  if (mission.iteration >= mission.maxIterations) {
    return {
      action: "pause",
      rationale: `Mission reached its ${mission.maxIterations}-iteration limit`,
    };
  }

  if (!experiment.analysis?.success) {
    return {
      action: "pivot",
      rationale: "The latest experiment failed or produced an invalid result",
      nextHypotheses: experiment.analysis?.nextSteps,
    };
  }

  return {
    action: "continue",
    rationale:
      "The mission remains within budget and has unmet success metrics",
    nextHypotheses: experiment.analysis.nextSteps,
  };
}
