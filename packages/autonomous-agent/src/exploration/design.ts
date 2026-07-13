/**
 * Deterministic offline experiment designer.
 *
 * This fallback produces an honest executable benchmark and never claims to
 * implement a domain-specific intervention. LLM mode can replace it with a
 * mission-specific design through the reasoning provider.
 */

import { randomUUID } from "node:crypto";
import type { Experiment, Hypothesis } from "../types/experiment.js";
import type { Mission } from "../types/mission.js";

export function designExperiment(
  mission: Mission,
  hypothesis: Hypothesis,
): Experiment {
  const id = `exp-${randomUUID()}`;
  const isBaseline = hypothesis.id.includes("baseline");

  return {
    id,
    missionId: mission.id,
    hypothesis,
    status: "designed",
    design: {
      description: isBaseline
        ? "Measure a reproducible local execution baseline"
        : `Collect reproducible evidence related to: ${hypothesis.statement}`,
      steps: isBaseline
        ? [
            "Run a deterministic CPU workload",
            "Measure elapsed time and throughput",
            "Write a structured results.json document",
          ]
        : [
            "Run a deterministic local probe",
            "Record measurements without claiming a domain intervention",
            "Report the missing domain evidence as a knowledge gap",
          ],
      code: generateOfflineExperimentCode(mission, hypothesis, isBaseline),
      codeLanguage: "javascript",
      entrypoint: "experiment.mjs",
      expectedDuration: "< 1 minute",
      resourceEstimate: {
        cpu: 1,
        memory: "128MB",
        disk: "10MB",
      },
    },
    createdAt: new Date().toISOString(),
  };
}

function generateOfflineExperimentCode(
  mission: Mission,
  hypothesis: Hypothesis,
  isBaseline: boolean,
): string {
  const experimentsMetric = mission.successMetrics.find(
    (metric) => metric.name.toLowerCase() === "experiments completed",
  );
  const metricUpdates = experimentsMetric
    ? {
        [experimentsMetric.name]: mission.experimentIds.length + 1,
      }
    : {};

  return `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const iterations = 250000;
let checksum = 0;
const startedAt = performance.now();

for (let index = 0; index < iterations; index += 1) {
  checksum = (checksum + ((index * 31) % 997)) % 1000000007;
}

const durationMs = performance.now() - startedAt;
const throughput = iterations / Math.max(durationMs / 1000, 0.000001);
const result = {
  status: ${JSON.stringify(isBaseline ? "completed" : "inconclusive")},
  hypothesisSupported: null,
  measurements: {
    iterations,
    duration_ms: Number(durationMs.toFixed(3)),
    operations_per_second: Number(throughput.toFixed(2)),
    checksum
  },
  metricUpdates: ${JSON.stringify(metricUpdates)},
  findings: [
    ${JSON.stringify(
      isBaseline
        ? "A deterministic local execution baseline was measured."
        : "A deterministic probe ran, but it did not implement the domain-specific intervention.",
    )}
  ],
  unexpectedFindings: [],
  knowledgeGaps: ${
    isBaseline
      ? "[]"
      : JSON.stringify([
          `A mission-specific intervention is required to test: ${hypothesis.statement}`,
        ])
  },
  nextSteps: ${
    isBaseline
      ? JSON.stringify([
          `Design a mission-specific intervention for: ${hypothesis.statement}`,
        ])
      : JSON.stringify([
          "Use configured LLM reasoning or provide reviewed experiment code.",
        ])
  }
};

await writeFile("results.json", JSON.stringify(result, null, 2) + "\\n", "utf8");
console.log(JSON.stringify(result.measurements));
`;
}
