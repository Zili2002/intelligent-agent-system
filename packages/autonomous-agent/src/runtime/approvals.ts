import os from "node:os";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isBudgetExhausted,
  loadMissionForExecution,
  saveMissionState,
} from "../mission/manager.js";
import { assessExperimentSafety } from "../sandbox/safety.js";
import { loadExperiment, saveExperiment } from "../experiment/store.js";
import type { AgentConfig } from "../types/config.js";
import type { Experiment } from "../types/experiment.js";
import { appendRunEvent } from "./store.js";
import type { ApprovalRequest } from "./types.js";

const APPROVALS_DIR = path.join("approvals", "requests");

export async function listPendingApprovals(
  root: string,
  missionId?: string,
): Promise<Experiment[]> {
  const directory = path.join(root, "experiments");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const pending: Experiment[] = [];
  for (const name of names) {
    try {
      const experiment = JSON.parse(
        await readFile(path.join(directory, name, "experiment.json"), "utf8"),
      ) as Experiment;
      if (
        experiment.status === "awaiting_approval" &&
        (!missionId || experiment.missionId === missionId)
      ) {
        pending.push(experiment);
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return pending.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export async function approveExperiment(
  root: string,
  missionReference: string,
  experimentId: string,
  config: AgentConfig,
  actor = defaultActor(),
): Promise<Experiment> {
  const mission = await loadMissionForExecution(missionReference, root);
  const experiment = await loadExperiment(experimentId, root);
  if (experiment.missionId !== mission.id) {
    throw new Error(
      `Experiment ${experiment.id} does not belong to ${mission.id}`,
    );
  }
  if (experiment.status !== "awaiting_approval") {
    throw new Error(`Experiment ${experiment.id} is not awaiting approval`);
  }
  if (isBudgetExhausted(mission, config.budget.alerts.stopAt)) {
    throw new Error(
      "Cannot approve an experiment after the budget stop threshold",
    );
  }
  const safety = assessExperimentSafety(experiment, mission, config);
  if (!safety.safe) {
    throw new Error(
      `Cannot approve unsafe experiment: ${safety.violations.join("; ")}`,
    );
  }
  experiment.status = "approved";
  experiment.approvedAt = new Date().toISOString();
  await saveExperiment(experiment, root);
  await appendRunEvent(root, {
    timestamp: experiment.approvedAt,
    runId: `approval-${experiment.id}`,
    missionId: mission.id,
    type: "approval_granted",
    message: `Experiment ${experiment.id} approved by ${actor}`,
  });
  return experiment;
}

export async function rejectExperiment(
  root: string,
  missionReference: string,
  experimentId: string,
  reason: string,
  actor = defaultActor(),
): Promise<Experiment> {
  if (!reason.trim()) throw new Error("Approval rejection requires a reason");
  const mission = await loadMissionForExecution(missionReference, root);
  const experiment = await loadExperiment(experimentId, root);
  if (experiment.missionId !== mission.id) {
    throw new Error(
      `Experiment ${experiment.id} does not belong to ${mission.id}`,
    );
  }
  if (experiment.status !== "awaiting_approval") {
    throw new Error(`Experiment ${experiment.id} is not awaiting approval`);
  }
  experiment.status = "cancelled";
  experiment.completedAt = new Date().toISOString();
  mission.notes.push(
    `Experiment ${experiment.id} rejected by ${actor}: ${reason.trim()}`,
  );
  await Promise.all([
    saveExperiment(experiment, root),
    saveMissionState(mission, root),
  ]);
  await appendRunEvent(root, {
    timestamp: experiment.completedAt,
    runId: `approval-${experiment.id}`,
    missionId: mission.id,
    type: "approval_rejected",
    message: `Experiment ${experiment.id} rejected by ${actor}: ${reason.trim()}`,
  });
  return experiment;
}

export async function ensureApprovalRequest(
  root: string,
  missionId: string,
  summary: string,
  details?: Record<string, unknown>,
): Promise<ApprovalRequest> {
  const existing = await loadApprovalRequest(root, missionId);
  if (existing && existing.status !== "consumed") return existing;
  const timestamp = new Date().toISOString();
  const request: ApprovalRequest = {
    version: 1,
    id: existing?.id ?? approvalRequestId(missionId),
    missionId,
    type: "llm_design",
    status: "pending",
    summary,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(details ? { details } : {}),
  };
  await saveApprovalRequest(root, request);
  return request;
}

export async function getApprovalRequestForMission(
  root: string,
  missionId: string,
): Promise<ApprovalRequest | undefined> {
  return loadApprovalRequest(root, missionId);
}

export async function listApprovalRequests(
  root: string,
  missionId?: string,
): Promise<ApprovalRequest[]> {
  const directory = path.join(root, APPROVALS_DIR);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const requests: ApprovalRequest[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const request = JSON.parse(
      await readFile(path.join(directory, name), "utf8"),
    ) as ApprovalRequest;
    if (
      request.status === "pending" &&
      (!missionId || request.missionId === missionId)
    ) {
      requests.push(request);
    }
  }
  return requests.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export async function isApprovalRequestApproved(
  root: string,
  missionId: string,
): Promise<boolean> {
  return (await loadApprovalRequest(root, missionId))?.status === "approved";
}

export async function consumeApprovalRequest(
  root: string,
  missionId: string,
): Promise<void> {
  const request = await loadApprovalRequest(root, missionId);
  if (!request || request.status !== "approved") return;
  request.status = "consumed";
  request.updatedAt = new Date().toISOString();
  await saveApprovalRequest(root, request);
}

export async function approveRequest(
  root: string,
  requestId: string,
  actor = defaultActor(),
  expectedMissionId?: string,
): Promise<ApprovalRequest> {
  const request = await loadApprovalRequestById(root, requestId);
  if (!request || request.status !== "pending") {
    throw new Error(`Approval request ${requestId} is not pending`);
  }
  if (expectedMissionId && request.missionId !== expectedMissionId) {
    throw new Error(
      `Approval request ${requestId} belongs to ${request.missionId}, not ${expectedMissionId}`,
    );
  }
  request.status = "approved";
  request.actor = actor;
  request.updatedAt = new Date().toISOString();
  await saveApprovalRequest(root, request);
  await appendRunEvent(root, {
    timestamp: request.updatedAt,
    runId: request.id,
    missionId: request.missionId,
    type: "approval_granted",
    message: `LLM design request ${request.id} approved by ${actor}`,
  });
  return request;
}

export async function rejectRequest(
  root: string,
  requestId: string,
  reason: string,
  actor = defaultActor(),
  expectedMissionId?: string,
): Promise<ApprovalRequest> {
  if (!reason.trim()) throw new Error("Approval rejection requires a reason");
  const request = await loadApprovalRequestById(root, requestId);
  if (!request || request.status !== "pending") {
    throw new Error(`Approval request ${requestId} is not pending`);
  }
  if (expectedMissionId && request.missionId !== expectedMissionId) {
    throw new Error(
      `Approval request ${requestId} belongs to ${request.missionId}, not ${expectedMissionId}`,
    );
  }
  request.status = "rejected";
  request.actor = actor;
  request.reason = reason.trim();
  request.updatedAt = new Date().toISOString();
  await saveApprovalRequest(root, request);
  await appendRunEvent(root, {
    timestamp: request.updatedAt,
    runId: request.id,
    missionId: request.missionId,
    type: "approval_rejected",
    message: `LLM design request ${request.id} rejected by ${actor}: ${reason.trim()}`,
  });
  return request;
}

async function loadApprovalRequest(
  root: string,
  missionId: string,
): Promise<ApprovalRequest | undefined> {
  return loadApprovalRequestById(root, approvalRequestId(missionId));
}

async function loadApprovalRequestById(
  root: string,
  requestId: string,
): Promise<ApprovalRequest | undefined> {
  try {
    return JSON.parse(
      await readFile(
        path.join(root, APPROVALS_DIR, `${requestId}.json`),
        "utf8",
      ),
    ) as ApprovalRequest;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function saveApprovalRequest(
  root: string,
  request: ApprovalRequest,
): Promise<void> {
  const directory = path.join(root, APPROVALS_DIR);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${request.id}.json`);
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function approvalRequestId(missionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(missionId)) {
    throw new Error(`Invalid mission ID for approval: ${missionId}`);
  }
  return `approval-llm-${missionId}`;
}

function defaultActor(): string {
  return `${os.userInfo().username}@${os.hostname()}`;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
