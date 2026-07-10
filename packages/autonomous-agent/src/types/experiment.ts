/**
 * Experiment type definitions.
 *
 * Defines experiments, hypotheses, execution results,
 * and analysis outcomes.
 */

/** Experiment status */
export type ExperimentStatus =
  | "designed"
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
    codeLanguage?: "typescript" | "python" | "bash";
    expectedDuration: string;
    resourceEstimate: {
      cpu: number;
      memory: string;
      disk: string;
    };
  };

  execution?: {
    startedAt: string;
    completedAt?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    metricsCollected?: Record<string, any>;
  };

  analysis?: {
    success: boolean;
    hypothesisSupported: boolean;
    insights: string[];
    unexpectedFindings: string[];
    nextSteps: string[];
  };

  createdAt: string;
  approvedAt?: string;
  completedAt?: string;
}

/** Experiment result summary */
export interface ExperimentResult {
  experimentId: string;
  success: boolean;
  hypothesisSupported: boolean;
  keyInsights: string[];
  dataGenerated: string[]; // file paths
  knowledgeUpdates: string[]; // wiki pages to update
}
