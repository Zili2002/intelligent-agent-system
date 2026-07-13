/**
 * Experiment type definitions.
 *
 * Defines experiments, hypotheses, execution results,
 * and analysis outcomes.
 */

/** Experiment status */
export type ExperimentStatus =
  | "designed"
  | "awaiting_approval"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Hypothesis to be tested */
export interface Hypothesis {
  id: string;
  statement: string;
  rationale: string;
  expectedOutcome: string;
  confidence: number; // 0-1
  relatedKnowledge: string[]; // wiki page slugs
}

/** Experiment design */
export interface Experiment {
  id: string;
  missionId: string;
  hypothesis: Hypothesis;
  status: ExperimentStatus;

  design: {
    description: string;
    steps: string[];
    code?: string;
    codeLanguage?: "javascript" | "typescript" | "python" | "bash";
    entrypoint?: string;
    origin?: "rule-based" | "anthropic" | "manual";
    expectedDuration: string;
    resourceEstimate: {
      cpu: number;
      memory: string;
      disk: string;
    };
  };

  execution?: {
    runId?: string;
    startedAt: string;
    completedAt?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    durationSeconds?: number;
    metricsCollected?: Record<string, unknown>;
  };

  analysis?: {
    success: boolean;
    hypothesisSupported: boolean | null;
    insights: string[];
    unexpectedFindings: string[];
    nextSteps: string[];
    metricUpdates: Record<string, string>;
    measurements: Record<string, unknown>;
    knowledgeGaps: string[];
  };

  createdAt: string;
  approvedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}

/** Experiment result summary */
export interface ExperimentResult {
  experimentId: string;
  success: boolean;
  hypothesisSupported: boolean | null;
  keyInsights: string[];
  dataGenerated: string[]; // file paths
  knowledgeUpdates: string[]; // wiki pages to update
}

export interface ExperimentResultDocument {
  runId?: string;
  status: "completed" | "failed" | "inconclusive";
  hypothesisSupported?: boolean | null;
  measurements?: Record<string, unknown>;
  metricUpdates?: Record<string, string | number | boolean>;
  findings?: string[];
  unexpectedFindings?: string[];
  knowledgeGaps?: string[];
  nextSteps?: string[];
}
