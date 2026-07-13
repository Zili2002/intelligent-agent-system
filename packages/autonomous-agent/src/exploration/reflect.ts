/**
 * Convert verified experiment outcomes into reusable mission learning.
 */

import type { Experiment } from "../types/experiment.js";
import type { Reflection } from "../types/exploration.js";
import type { Mission } from "../types/mission.js";

export function reflectOnExperiment(
  mission: Mission,
  experiment: Experiment,
): Reflection {
  if (!experiment.analysis) {
    throw new Error(`Experiment ${experiment.id} has not been analyzed`);
  }

  const analysis = experiment.analysis;
  const whatWorked = analysis.success
    ? ["Experiment executed and produced a valid result document"]
    : [];
  const whatDidntWork = analysis.success
    ? analysis.unexpectedFindings
    : [
        "Experiment did not complete successfully",
        ...analysis.unexpectedFindings,
      ];
  const lessonsLearned = [
    ...analysis.insights,
    ...analysis.knowledgeGaps.map((gap) => `Knowledge gap: ${gap}`),
  ];

  return {
    missionId: mission.id,
    experimentId: experiment.id,
    timestamp: new Date().toISOString(),
    whatWorked,
    whatDidntWork,
    lessonsLearned,
    knowledgeExtracted: analysis.insights.map((insight) => ({
      concept: mission.name,
      insight,
      confidence:
        analysis.hypothesisSupported === true
          ? 0.8
          : analysis.hypothesisSupported === false
            ? 0.6
            : 0.5,
    })),
    patternsIdentified:
      analysis.hypothesisSupported === true
        ? [`Supported approach: ${experiment.hypothesis.statement}`]
        : [],
    toolsNeeded: [],
  };
}
