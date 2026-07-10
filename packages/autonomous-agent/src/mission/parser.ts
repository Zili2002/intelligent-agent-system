/**
 * Mission parser - parses mission markdown files into structured data.
 */

import { readFile } from "fs/promises";
import type {
  Mission,
  Constraint,
  SuccessMetric,
  Checkpoint,
  Budget,
} from "../types/mission.js";

/**
 * Parse a mission markdown file into a structured Mission object.
 */
export async function parseMission(filePath: string): Promise<Mission> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");

  let currentSection = "";
  const sections: Record<string, string[]> = {};

  for (const line of lines) {
    if (line.startsWith("##")) {
      currentSection = line.replace(/^##\s*/, "").toLowerCase();
      sections[currentSection] = [];
    } else if (currentSection && line.trim()) {
      sections[currentSection].push(line);
    }
  }

  const titleMatch = content.match(/^#\s*Mission:\s*(.+)$/m);
  const name = titleMatch ? titleMatch[1].trim() : "Untitled Mission";
  const id = generateMissionId(name);

  return {
    id,
    name,
    objective: parseObjective(sections.objective || []),
    status: "pending",
    priority: "medium",
    constraints: parseConstraints(sections.constraints || []),
    successMetrics: parseSuccessMetrics(sections["success metrics"] || []),
    checkpoints: parseCheckpoints(sections.checkpoints || []),
    budget: parseBudget(sections.budget || []),
    createdAt: new Date().toISOString(),
    experimentIds: [],
    notes: [],
  };
}

function parseObjective(lines: string[]): string {
  return lines.join("\n").trim();
}

function parseConstraints(lines: string[]): Constraint[] {
  const constraints: Constraint[] = [];

  for (const line of lines) {
    const match = line.match(/^-\s*(.+)$/);
    if (match) {
      const text = match[1].trim();
      let type: Constraint["type"] = "technical";

      if (/time|deadline|week|day/i.test(text)) type = "time";
      else if (/resource|budget|cost/i.test(text)) type = "resource";
      else if (/ethical|privacy|safety/i.test(text)) type = "ethical";

      constraints.push({ type, description: text });
    }
  }

  return constraints;
}

function parseSuccessMetrics(lines: string[]): SuccessMetric[] {
  const metrics: SuccessMetric[] = [];

  for (const line of lines) {
    const match = line.match(/^-\s*(.+?):\s*(.+)$/);
    if (match) {
      metrics.push({
        name: match[1].trim(),
        target: match[2].trim(),
        achieved: false,
      });
    }
  }

  return metrics;
}

function parseCheckpoints(lines: string[]): Checkpoint[] {
  const checkpoints: Checkpoint[] = [];

  for (const line of lines) {
    const match = line.match(/^-\s*(.+?):\s*(.+)$/);
    if (match) {
      checkpoints.push({
        date: match[1].trim(),
        description: match[2].trim(),
        completed: false,
      });
    }
  }

  return checkpoints;
}

function parseBudget(lines: string[]): Budget {
  const budget: Budget = {
    llmTokens: 0,
    llmTokensUsed: 0,
    computeHours: 0,
    computeHoursUsed: 0,
    approvalRequired: false,
  };

  for (const line of lines) {
    const tokensMatch = line.match(/LLM Tokens:\s*(\d+)([MK])?/i);
    if (tokensMatch) {
      let tokens = parseInt(tokensMatch[1], 10);
      if (tokensMatch[2] === "M") tokens *= 1_000_000;
      else if (tokensMatch[2] === "K") tokens *= 1_000;
      budget.llmTokens = tokens;
    }

    const computeMatch = line.match(/Compute:\s*(\d+)\s*GPU hours?/i);
    if (computeMatch) {
      budget.computeHours = parseInt(computeMatch[1], 10);
    }

    const approvalMatch = line.match(/Approval Required:\s*(Yes|No)/i);
    if (approvalMatch) {
      budget.approvalRequired = approvalMatch[1].toLowerCase() === "yes";
    }
  }

  return budget;
}

function generateMissionId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const timestamp = Date.now().toString(36);
  return `mission-${slug}-${timestamp}`;
}
