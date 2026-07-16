/**
 * Deterministic experiment result analysis.
 */

import type {
  Experiment,
  ExperimentResultDocument,
} from "../types/experiment.js";
import type { ExecutionResult } from "../types/sandbox.js";

export function analyzeExperiment(
  experiment: Experiment,
  execution: ExecutionResult,
  result: ExperimentResultDocument,
): NonNullable<Experiment["analysis"]> {
  const findings = stringArray(result.findings);
  const unexpectedFindings = stringArray(result.unexpectedFindings);
  const nextSteps = stringArray(result.nextSteps);
  const knowledgeGaps = stringArray(result.knowledgeGaps);
  const metricUpdates = normalizeMetricUpdates(result.metricUpdates);
  const completed = result.status === "completed";

  if (!execution.success) {
    unexpectedFindings.unshift(
      execution.error ?? `Experiment exited with code ${execution.exitCode}`,
    );
  }

  if (findings.length === 0 && completed) {
    findings.push(
      "Experiment completed but did not report evidence-bearing findings",
    );
  }

  return {
    success: execution.success && completed,
    hypothesisSupported:
      typeof result.hypothesisSupported === "boolean"
        ? result.hypothesisSupported
        : null,
    insights: findings,
    unexpectedFindings,
    nextSteps,
    metricUpdates,
    measurements: isRecord(result.measurements) ? result.measurements : {},
    knowledgeGaps,
  };
}

function normalizeMetricUpdates(
  updates?: Record<string, string | number | boolean>,
): Record<string, string> {
  if (!isRecord(updates)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(updates).map(([name, value]) => [name, String(value)]),
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim() !== "",
      )
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
