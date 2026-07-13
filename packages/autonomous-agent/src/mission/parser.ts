/**
 * Mission Markdown parser.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  Budget,
  Checkpoint,
  Constraint,
  Mission,
  MissionStatus,
  Priority,
  SuccessMetric,
} from "../types/mission.js";

interface ParsedDocument {
  metadata: Record<string, string>;
  sections: Record<string, string[]>;
}

/**
 * Parse a mission Markdown file into a stable structured mission.
 */
export async function parseMission(filePath: string): Promise<Mission> {
  const content = await readFile(filePath, "utf8");
  const { metadata, sections } = splitDocument(content);
  const titleMatch = content.match(/^#\s*Mission:\s*(.+)$/im);
  const name = titleMatch?.[1].trim() || "Untitled Mission";
  const now = new Date().toISOString();

  return {
    id: generateMissionId(name),
    name,
    objective: parseObjective(sections.objective ?? []),
    sourcePath: path.resolve(filePath),
    status: parseStatus(metadata.status),
    priority: parsePriority(metadata.priority),
    constraints: parseConstraints(sections.constraints ?? []),
    successMetrics: parseSuccessMetrics(
      sections["success criteria"] ?? sections["success metrics"] ?? [],
    ),
    checkpoints: parseCheckpoints(sections.checkpoints ?? []),
    budget: parseBudget(metadata, sections.budget ?? []),
    createdAt: now,
    updatedAt: now,
    experimentIds: [],
    notes: [],
    findings: [],
    knowledgeGaps: [],
    iteration: 0,
    maxIterations: parsePositiveInteger(metadata.iterations) ?? 10,
  };
}

function splitDocument(content: string): ParsedDocument {
  const metadata: Record<string, string> = {};
  const sections: Record<string, string[]> = {};
  let currentSection = "";

  for (const rawLine of content.split(/\r?\n/)) {
    const heading = rawLine.match(/^#{2,6}\s+(.+?)\s*$/);
    if (heading) {
      currentSection = normalizeSectionName(heading[1]);
      sections[currentSection] ??= [];
      continue;
    }

    if (!currentSection) {
      const metadataMatch = rawLine.match(
        /^\s*\*\*([^*]+)\*\*\s*:\s*(.+?)\s*$/,
      );
      if (metadataMatch) {
        metadata[metadataMatch[1].trim().toLowerCase()] =
          metadataMatch[2].trim();
      }
      continue;
    }

    if (rawLine.trim()) {
      sections[currentSection].push(rawLine.trimEnd());
    }
  }

  return { metadata, sections };
}

function normalizeSectionName(value: string): string {
  return value
    .replace(/\s+\([^)]*\)\s*$/, "")
    .trim()
    .toLowerCase();
}

function parseObjective(lines: string[]): string {
  return lines.join("\n").trim();
}

function parseConstraints(lines: string[]): Constraint[] {
  return listItems(lines).map((item) => {
    const description = stripBoldLabel(item);
    let type: Constraint["type"] = "technical";

    if (/\b(time|deadline|duration|week|day|hour)\b/i.test(description)) {
      type = "time";
    } else if (
      /\b(resource|budget|cost|token|compute|gpu|cpu)\b/i.test(description)
    ) {
      type = "resource";
    } else if (/\b(ethical|privacy|safety|security)\b/i.test(description)) {
      type = "ethical";
    }

    return { type, description };
  });
}

function parseSuccessMetrics(lines: string[]): SuccessMetric[] {
  const metrics: SuccessMetric[] = [];

  for (const item of listItems(lines)) {
    const match = item.match(/^(?:\*\*)?(.+?)(?:\*\*)?\s*:\s*(.+)$/);
    if (!match) {
      continue;
    }

    metrics.push({
      name: match[1].replace(/\*\*/g, "").trim(),
      target: match[2].trim(),
      achieved: false,
    });
  }

  return metrics;
}

function parseCheckpoints(lines: string[]): Checkpoint[] {
  const checkpoints: Checkpoint[] = [];

  for (const item of listItems(lines)) {
    const match = item.match(/^(.+?)\s*:\s*(.+)$/);
    if (!match) {
      continue;
    }

    checkpoints.push({
      date: match[1].replace(/\*\*/g, "").trim(),
      description: match[2].trim(),
      completed: false,
    });
  }

  return checkpoints;
}

function parseBudget(
  metadata: Record<string, string>,
  lines: string[],
): Budget {
  const budget: Budget = {
    llmTokens: 0,
    llmTokensUsed: 0,
    computeHours: 0,
    computeHoursUsed: 0,
    costLimit: 0,
    costSpent: 0,
    currency: "USD",
    approvalRequired: false,
  };
  const text = [metadata.budget ?? "", ...lines].join("\n");

  const tokensMatch = text.match(/LLM\s*Tokens?\s*:\s*([\d,.]+)\s*([KMB])?/i);
  if (tokensMatch) {
    budget.llmTokens = parseScaledNumber(tokensMatch[1], tokensMatch[2]);
  }

  const computeMatch = text.match(
    /Compute\s*:\s*([\d,.]+)\s*(?:GPU|CPU)?\s*hours?/i,
  );
  if (computeMatch) {
    budget.computeHours = parseNumber(computeMatch[1]);
  }

  const moneyMatch = text.match(/\$\s*([\d,.]+)(?:\s*USD)?/i);
  if (moneyMatch) {
    budget.costLimit = parseNumber(moneyMatch[1]);
  }

  const approvalMatch = text.match(/Approval\s*Required\s*:\s*(Yes|No)/i);
  if (approvalMatch) {
    budget.approvalRequired = approvalMatch[1].toLowerCase() === "yes";
  }

  return budget;
}

function listItems(lines: string[]): string[] {
  const items: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/);
    if (match) {
      items.push(match[1]);
    }
  }

  return items;
}

function stripBoldLabel(value: string): string {
  return value.replace(/^\*\*([^*]+)\*\*\s*:\s*/, "$1: ").trim();
}

function parseStatus(value?: string): MissionStatus {
  switch (value?.trim().toLowerCase()) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    case "failed":
    case "abandoned":
      return "failed";
    default:
      return "pending";
  }
}

function parsePriority(value?: string): Priority {
  switch (value?.trim().toLowerCase()) {
    case "low":
      return "low";
    case "high":
      return "high";
    case "critical":
      return "critical";
    default:
      return "medium";
  }
}

function parsePositiveInteger(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseScaledNumber(value: string, suffix?: string): number {
  const multipliers: Record<string, number> = {
    K: 1_000,
    M: 1_000_000,
    B: 1_000_000_000,
  };
  return Math.floor(
    parseNumber(value) * (multipliers[suffix?.toUpperCase() ?? ""] ?? 1),
  );
}

function parseNumber(value: string): number {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function generateMissionId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "");
  return `mission-${slug || "untitled"}`;
}
