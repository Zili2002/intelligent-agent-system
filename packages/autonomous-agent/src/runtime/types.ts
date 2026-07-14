import type { Decision } from "../types/exploration.js";

export type RunStatus =
  | "running"
  | "completed"
  | "paused"
  | "waiting_approval"
  | "failed"
  | "stopped";

export interface RunBudgetSnapshot {
  llmTokensUsed: number;
  computeHoursUsed: number;
  costSpent: number;
}

export interface RunRecord {
  version: 1;
  id: string;
  missionId: string;
  mode: "continuous";
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  cycles: number;
  attempts: number;
  lastExperimentId?: string;
  lastDecision?: Decision;
  budgetBefore: RunBudgetSnapshot;
  budgetAfter: RunBudgetSnapshot;
  error?: string;
}

export interface RunEvent {
  timestamp: string;
  runId: string;
  missionId: string;
  type:
    | "run_started"
    | "cycle_started"
    | "cycle_completed"
    | "retry_scheduled"
    | "approval_required"
    | "experiment_recovered"
    | "run_completed"
    | "run_failed"
    | "run_stopped"
    | "approval_granted"
    | "approval_rejected";
  message: string;
  details?: Record<string, unknown>;
}

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export interface HealthCheck {
  name: string;
  status: "ok" | "warning" | "error";
  message: string;
}

export interface HealthReport {
  status: "healthy" | "degraded" | "unhealthy";
  checkedAt: string;
  root: string;
  checks: HealthCheck[];
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "consumed";

export interface ApprovalRequest {
  version: 1;
  id: string;
  missionId: string;
  type: "llm_design";
  status: ApprovalStatus;
  summary: string;
  createdAt: string;
  updatedAt: string;
  actor?: string;
  reason?: string;
  details?: Record<string, unknown>;
}
