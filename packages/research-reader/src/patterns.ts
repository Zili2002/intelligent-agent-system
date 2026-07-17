import { readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText } from "@intelligent-agent/shared";
import type { ReasoningPattern, ResolvedReaderConfig } from "./types.js";

const DEFAULT_PATTERNS = [
  {
    id: "method-evaluation",
    title: "Method evaluation",
    checks: [
      "State the problem and assumptions.",
      "Identify the mechanism that differs from prior work.",
      "Separate claimed contribution from verified evidence.",
      "Record applicability limits and alternatives.",
    ],
  },
  {
    id: "experiment-rigor",
    title: "Experiment rigor",
    checks: [
      "Check baseline and data comparability.",
      "Check ablations, variance, and negative results.",
      "Check whether results support each stated conclusion.",
      "Record missing controls and confounders.",
    ],
  },
  {
    id: "reproducibility",
    title: "Reproducibility",
    checks: [
      "Locate code, data, parameters, and environment details.",
      "Record unavailable implementation decisions.",
      "Estimate resources separately from scientific quality.",
      "List the smallest reproducible experiment.",
    ],
  },
  {
    id: "survey-coverage",
    title: "Survey coverage",
    checks: [
      "Define inclusion and exclusion boundaries.",
      "Build a source-to-claim evidence matrix.",
      "Include supporting, qualifying, and contradictory evidence.",
      "Expose uncovered periods, methods, and evaluation settings.",
    ],
  },
];

export async function initializeReasoningPatterns(
  config: ResolvedReaderConfig,
): Promise<ReasoningPattern[]> {
  for (const pattern of DEFAULT_PATTERNS) {
    const filePath = path.join(config.patternsDir, `${pattern.id}.md`);
    if (!(await exists(filePath))) {
      await atomicWriteText(
        filePath,
        `# ${pattern.title}

${pattern.checks.map((check) => `- [ ] ${check}`).join("\n")}
`,
      );
    }
  }
  return listReasoningPatterns(config);
}

export async function listReasoningPatterns(
  config: ResolvedReaderConfig,
): Promise<ReasoningPattern[]> {
  let names: string[];
  try {
    names = await readdir(config.patternsDir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({
      id: path.basename(name, ".md"),
      title: titleFromId(path.basename(name, ".md")),
      path: path.join(config.patternsDir, name),
    }));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function titleFromId(id: string): string {
  return id
    .split("-")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
