/**
 * Exploration engine type definitions.
 *
 * Defines the Orient-Hypothesize-Design-Execute-Analyze-Reflect-Decide cycle.
 */

import type { Mission } from "./mission.js";
import type { Hypothesis, Experiment } from "./experiment.js";

/** Current situation analysis */
export interface Situation {
  missionId: string;
  timestamp: string;

  currentState: {
    progress: number; // 0-1
    metricsAchieved: number;
    experimentsCompleted: number;
    knowledgeGaps: string[];
  };

  opportunities: Array<{
    description: string;
    priority: "low" | "medium" | "high";
    estimatedImpact: string;
  }>;

  risks: Array<{
    description: string;
    severity: "low" | "medium" | "high";
    mitigation?: string;
  }>;

  recommendations: string[];
}

/** Decision on next action */
export interface Decision {
  action: "continue" | "pivot" | "pause" | "complete";
  rationale: string;
  nextHypotheses?: string[];
  adjustments?: Array<{
    type: "budget" | "timeline" | "scope";
    description: string;
  }>;
}

/** Reflection on completed work */
export interface Reflection {
  missionId: string;
  experimentId: string;
  timestamp: string;

  whatWorked: string[];
  whatDidntWork: string[];
  lessonsLearned: string[];
  knowledgeExtracted: Array<{
    concept: string;
    insight: string;
    confidence: number;
  }>;

  patternsIdentified: string[];
  toolsNeeded: string[];
}
