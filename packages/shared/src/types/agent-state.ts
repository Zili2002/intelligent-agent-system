/**
 * Agent state snapshot for multi-device synchronization
 *
 * This file defines the structure of .agent-state.json, which is committed
 * to Git and provides context handoff between agents running on different devices.
 */

export interface AgentState {
  version: string;
  lastUpdated: string;
  device: string;

  session: SessionInfo;
  mission: MissionInfo;
  knowledge: KnowledgeInfo;
  exploration: ExplorationInfo;
  evolution: EvolutionInfo;
  context: ContextInfo;
  sync: SyncInfo;
}

export interface SessionInfo {
  id: string;
  startedAt: string;
  endedAt?: string;
}

export interface MissionInfo {
  id: string;
  path: string;
  status: "active" | "paused" | "completed";
  progress: {
    phase: string;
    completedTasks: string[];
    nextActions: string[];
  };
  budget: {
    limit: number;
    spent: number;
    currency: "USD" | "tokens";
  };
}

export interface KnowledgeInfo {
  wikiPath: string;
  lastCompileAt: string;
  sourceCount: number;
  pageCount: number;
  lastSyncCommit: string;
}

export interface ExplorationInfo {
  hypothesesGenerated: number;
  experimentsRun: number;
  successfulExperiments: number;
  lastExperiment?: {
    id: string;
    description: string;
    result: "success" | "failure" | "inconclusive";
    timestamp: string;
  };
}

export interface EvolutionInfo {
  lastReflectionAt: string;
  knowledgeGaps: string[];
  proposedIdeas: string[];
  improvements: Improvement[];
}

export interface Improvement {
  type: "code" | "skill" | "prompt" | "config";
  description: string;
  appliedAt: string;
  commit: string;
}

export interface ContextInfo {
  keyFindings: string[];
  openQuestions: string[];
  decisions: Decision[];
  warnings: string[];
}

export interface Decision {
  question: string;
  decision: string;
  rationale: string;
  timestamp: string;
}

export interface SyncInfo {
  gitRemote: string;
  gitBranch: string;
  wikiRemote?: string;
  wikiBranch?: string;
  lastPullAt: string;
  lastPushAt: string;
  conflicts: Conflict[];
}

export interface Conflict {
  file: string;
  resolvedAt?: string;
}

export interface OnboardResult {
  state: AgentState | null;
  summary: string | null;
  isResume: boolean;
  warnings: string[];
}

export type DeepPartial<T> =
  T extends Array<infer Item>
    ? Array<Item>
    : T extends object
      ? { [Key in keyof T]?: DeepPartial<T[Key]> }
      : T;
