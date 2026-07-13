/**
 * Durable experiment storage.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Experiment,
  ExperimentResultDocument,
} from "../types/experiment.js";

export function experimentDirectory(
  root: string,
  experimentId: string,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(experimentId)) {
    throw new Error(`Invalid experiment ID: ${experimentId}`);
  }
  return path.join(root, "experiments", experimentId);
}

export async function saveExperiment(
  experiment: Experiment,
  root: string = process.cwd(),
): Promise<string> {
  const directory = experimentDirectory(root, experiment.id);
  await mkdir(directory, { recursive: true });
  experiment.updatedAt = new Date().toISOString();

  if (experiment.design.code) {
    const entrypoint =
      experiment.design.entrypoint ??
      defaultEntrypoint(experiment.design.codeLanguage);
    if (path.basename(entrypoint) !== entrypoint) {
      throw new Error(
        `Experiment entrypoint must be a filename: ${entrypoint}`,
      );
    }
    await writeFile(
      path.join(directory, entrypoint),
      experiment.design.code,
      "utf8",
    );
    experiment.design.entrypoint = entrypoint;
  }

  const filePath = path.join(directory, "experiment.json");
  await atomicWriteJson(filePath, experiment);
  return directory;
}

export async function loadExperiment(
  experimentId: string,
  root: string = process.cwd(),
): Promise<Experiment> {
  const filePath = path.join(
    experimentDirectory(root, experimentId),
    "experiment.json",
  );
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content) as Experiment;
}

export async function loadExperimentResult(
  experimentId: string,
  root: string = process.cwd(),
): Promise<ExperimentResultDocument> {
  const filePath = path.join(
    experimentDirectory(root, experimentId),
    "results.json",
  );
  let content: string;

  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Experiment ${experimentId} did not produce results.json: ${message}`,
    );
  }

  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Experiment ${experimentId} results must be a JSON object`);
  }
  if (
    parsed.status !== "completed" &&
    parsed.status !== "failed" &&
    parsed.status !== "inconclusive"
  ) {
    throw new Error(
      `Experiment ${experimentId} results.status must be completed, failed, or inconclusive`,
    );
  }

  return parsed as unknown as ExperimentResultDocument;
}

export async function clearExperimentOutputs(
  experimentId: string,
  root: string = process.cwd(),
): Promise<void> {
  const directory = experimentDirectory(root, experimentId);
  await Promise.all(
    ["results.json", "reflection.json"].map((name) =>
      rm(path.join(directory, name), { force: true }),
    ),
  );
}

function defaultEntrypoint(
  language: Experiment["design"]["codeLanguage"],
): string {
  switch (language) {
    case "python":
      return "experiment.py";
    case "bash":
      return "experiment.sh";
    case "typescript":
      return "experiment.ts";
    case "javascript":
    case undefined:
      return "experiment.mjs";
  }
}

async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
