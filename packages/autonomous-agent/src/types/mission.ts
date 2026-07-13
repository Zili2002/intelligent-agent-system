/**
 * Mission type definitions.
 *
 * Defines the structure of missions, objectives, constraints,
 * success metrics, and budget management.
 */

/** Mission status */
export type MissionStatus =
  | "pending"
  | "active"
  | "paused"
  | "completed"
  | "failed";

/** Priority level */
export type Priority = "low" | "medium" | "high" | "critical";

/** Budget tracking */
export interface Budget {
  llmTokens: number;
  llmTokensUsed: number;
  computeHours: number;
  computeHoursUsed: number;
  costLimit: number;
  costSpent: number;
  currency: "USD";
  approvalRequired: boolean;
}

/** Success metric */
export interface SuccessMetric {
  name: string;
  target: string;
  current?: string;
  achieved: boolean;
}

/** Mission checkpoint */
export interface Checkpoint {
  date: string;
  description: string;
  completed: boolean;
  completedAt?: string;
}

/** Mission constraint */
export interface Constraint {
  type: "time" | "resource" | "technical" | "ethical";
  description: string;
}

/** Complete mission definition */
export interface Mission {
  id: string;
  name: string;
  objective: string;
  sourcePath?: string;
  status: MissionStatus;
  priority: Priority;

  constraints: Constraint[];
  successMetrics: SuccessMetric[];
  checkpoints: Checkpoint[];
  budget: Budget;

  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;

  experimentIds: string[];
  successfulExperimentIds: string[];
  notes: string[];
  findings: string[];
  knowledgeGaps: string[];
  iteration: number;
  maxIterations: number;
}

/** Mission progress report */
export interface MissionProgress {
  missionId: string;
  status: MissionStatus;
  metricsAchieved: number;
  metricsTotal: number;
  checkpointsCompleted: number;
  checkpointsTotal: number;
  budgetUsedPercent: number;
  experimentsCompleted: number;
  iteration: number;
  daysElapsed: number;
  estimatedCompletion?: string;
}
