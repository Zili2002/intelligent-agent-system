import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Experiment } from "../types/experiment.js";

export async function findRecoverableExperiment(
  root: string,
  missionId: string,
): Promise<Experiment | undefined> {
  const experimentsDirectory = path.join(root, "experiments");
  let names: string[];
  try {
    names = await readdir(experimentsDirectory);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  const candidates: Experiment[] = [];
  for (const name of names) {
    try {
      const experiment = JSON.parse(
        await readFile(
          path.join(experimentsDirectory, name, "experiment.json"),
          "utf8",
        ),
      ) as Experiment;
      if (
        experiment.missionId === missionId &&
        (experiment.status === "running" ||
          experiment.status === "approved" ||
          experiment.status === "awaiting_approval")
      ) {
        candidates.push(experiment);
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return candidates.sort((left, right) =>
    (right.updatedAt ?? right.createdAt).localeCompare(
      left.updatedAt ?? left.createdAt,
    ),
  )[0];
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
