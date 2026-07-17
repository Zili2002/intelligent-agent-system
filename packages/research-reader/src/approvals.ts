import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  readJsonIfExists,
  sanitizeJson,
  withFileLock,
} from "@intelligent-agent/shared";
import type {
  ReaderApprovalRequest,
  ReaderApprovalType,
  ResolvedReaderConfig,
} from "./types.js";

export async function ensureApprovalRequest(
  config: ResolvedReaderConfig,
  type: ReaderApprovalType,
  summary: string,
  details: Record<string, unknown> = {},
  now = new Date(),
): Promise<ReaderApprovalRequest> {
  if (!summary.trim()) throw new Error("Approval summary must not be empty");
  return withFileLock(
    path.join(config.approvalsDir, ".approvals.lock"),
    async () => {
      const pending = (await listApprovalRequests(config)).find(
        (request) =>
          request.type === type &&
          request.status === "pending" &&
          request.summary === summary.trim(),
      );
      if (pending) return pending;
      const request: ReaderApprovalRequest = {
        version: 1,
        id: `reader-approval-${randomUUID()}`,
        type,
        status: "pending",
        summary: summary.trim(),
        details: sanitizeRecord(details),
        createdAt: now.toISOString(),
      };
      await saveApproval(config, request);
      return request;
    },
  );
}

export async function listApprovalRequests(
  config: ResolvedReaderConfig,
  status?: ReaderApprovalRequest["status"],
): Promise<ReaderApprovalRequest[]> {
  let names: string[];
  try {
    names = await readdir(config.approvalsDir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const requests: ReaderApprovalRequest[] = [];
  for (const name of names
    .filter(
      (entry) =>
        entry.startsWith("reader-approval-") && entry.endsWith(".json"),
    )
    .sort()) {
    const request = await readJsonIfExists(
      path.join(config.approvalsDir, name),
      parseApproval,
    );
    if (request && (!status || request.status === status)) {
      requests.push(request);
    }
  }
  return requests.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export async function approveRequest(
  config: ResolvedReaderConfig,
  requestId: string,
  decidedBy: string,
  now = new Date(),
): Promise<ReaderApprovalRequest> {
  return decide(config, requestId, "approved", decidedBy, undefined, now);
}

export async function rejectRequest(
  config: ResolvedReaderConfig,
  requestId: string,
  reason: string,
  decidedBy: string,
  now = new Date(),
): Promise<ReaderApprovalRequest> {
  if (!reason.trim()) throw new Error("Approval rejection reason is required");
  return decide(config, requestId, "rejected", decidedBy, reason.trim(), now);
}

export async function consumeApprovedRequest(
  config: ResolvedReaderConfig,
  type: ReaderApprovalType,
  now = new Date(),
): Promise<ReaderApprovalRequest | undefined> {
  return withFileLock(
    path.join(config.approvalsDir, ".approvals.lock"),
    async () => {
      const approved = (await listApprovalRequests(config, "approved"))
        .filter((request) => request.type === type)
        .sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt),
        )[0];
      if (!approved) return undefined;
      approved.status = "consumed";
      approved.decidedAt = now.toISOString();
      await saveApproval(config, approved);
      return approved;
    },
  );
}

async function decide(
  config: ResolvedReaderConfig,
  requestId: string,
  status: "approved" | "rejected",
  decidedBy: string,
  reason: string | undefined,
  now: Date,
): Promise<ReaderApprovalRequest> {
  if (!decidedBy.trim()) throw new Error("Approval actor must not be empty");
  const filePath = approvalPath(config, requestId);
  return withFileLock(`${filePath}.lock`, async () => {
    const request = await readJsonIfExists(filePath, parseApproval);
    if (!request) throw new Error(`Approval request not found: ${requestId}`);
    if (request.status !== "pending") {
      throw new Error(`Approval request is already ${request.status}`);
    }
    request.status = status;
    request.decidedAt = now.toISOString();
    request.decidedBy = decidedBy.trim();
    if (reason) request.rejectionReason = reason;
    await saveApproval(config, request);
    return request;
  });
}

async function saveApproval(
  config: ResolvedReaderConfig,
  request: ReaderApprovalRequest,
): Promise<void> {
  await atomicWriteJson(approvalPath(config, request.id), request);
}

function approvalPath(config: ResolvedReaderConfig, requestId: string): string {
  if (!/^reader-approval-[A-Za-z0-9-]+$/.test(requestId)) {
    throw new Error(`Invalid Reader approval ID: ${requestId}`);
  }
  return path.join(config.approvalsDir, `${requestId}.json`);
}

function parseApproval(value: unknown): ReaderApprovalRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("type" in value) ||
    typeof value.type !== "string" ||
    !("status" in value) ||
    typeof value.status !== "string" ||
    !("summary" in value) ||
    typeof value.summary !== "string" ||
    !("details" in value) ||
    typeof value.details !== "object" ||
    value.details === null ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string"
  ) {
    throw new Error("Invalid Reader approval request");
  }
  return value as ReaderApprovalRequest;
}

function sanitizeRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = sanitizeJson(value);
  if (
    typeof sanitized !== "object" ||
    sanitized === null ||
    Array.isArray(sanitized)
  ) {
    throw new Error("Approval details must be an object");
  }
  return sanitized as Record<string, unknown>;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
