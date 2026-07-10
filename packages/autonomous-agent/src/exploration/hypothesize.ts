/**
 * Hypothesis generator - generates testable hypotheses based on situation analysis.
 *
 * Takes the Orient analysis and mission objectives to propose hypotheses
 * that could help achieve the mission goals.
 */

import type { Mission } from "../types/mission.js";
import type { Situation } from "../types/exploration.js";
import type { Hypothesis } from "../types/experiment.js";

/**
 * Generate hypotheses based on current situation.
 * Returns ranked hypotheses ordered by potential impact.
 */
export function generateHypotheses(
  mission: Mission,
  situation: Situation
): Hypothesis[] {
  const hypotheses: Hypothesis[] = [];

  // If no experiments yet, generate baseline hypothesis
  if (mission.experimentIds.length === 0) {
    hypotheses.push(createBaselineHypothesis(mission));
  }

  // Generate hypotheses for unachieved metrics
  for (const metric of mission.successMetrics.filter((m) => !m.achieved)) {
    hypotheses.push(createMetricHypothesis(mission, metric));
  }

  // Generate exploratory hypotheses based on opportunities
  for (const opp of situation.opportunities.filter(
    (o) => o.priority === "high"
  )) {
    hypotheses.push(createOpportunityHypothesis(mission, opp));
  }

  // Rank by confidence and potential impact
  return hypotheses.sort((a, b) => b.confidence - a.confidence);
}

function createBaselineHypothesis(mission: Mission): Hypothesis {
  return {
    id: `hyp-${Date.now()}-baseline`,
    statement: `Establishing baseline performance will reveal current system capabilities`,
    rationale:
      "Before optimization, we need to measure current state to know what to improve",
    expectedOutcome:
      "Quantified baseline metrics that establish starting point",
    confidence: 0.9,
    relatedKnowledge: [],
  };
}

function createMetricHypothesis(
  mission: Mission,
  metric: any
): Hypothesis {
  return {
    id: `hyp-${Date.now()}-${metric.name.toLowerCase().replace(/\s+/g, "-")}`,
    statement: `Targeted intervention can achieve ${metric.name}: ${metric.target}`,
    rationale: `This metric is a success criterion for the mission`,
    expectedOutcome: `${metric.name} reaches or exceeds ${metric.target}`,
    confidence: 0.6,
    relatedKnowledge: [],
  };
}

function createOpportunityHypothesis(
  mission: Mission,
  opportunity: any
): Hypothesis {
  return {
    id: `hyp-${Date.now()}-opportunity`,
    statement: opportunity.description,
    rationale: `High-priority opportunity identified in Orient analysis`,
    expectedOutcome: opportunity.estimatedImpact,
    confidence: 0.7,
    relatedKnowledge: [],
  };
}
