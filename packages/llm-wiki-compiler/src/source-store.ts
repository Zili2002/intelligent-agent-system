import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import type { ServiceOptions, SourceArtifact } from "./types.js";
import { sha256, walkFiles } from "./utils.js";

export async function getSourceArtifact(
  sourceId: string,
  options: ServiceOptions = {},
): Promise<SourceArtifact | undefined> {
  validateSourceId(sourceId);
  const config = await loadConfig(options.root);
  const filePath = path.join(config.sourcesDir, `${sourceId}.json`);
  try {
    const artifact = parseSourceArtifact(
      JSON.parse(await readFile(filePath, "utf8")),
    );
    if (artifact.id !== sourceId) {
      throw new Error(
        `Source ID mismatch: requested ${sourceId}, stored ${artifact.id}`,
      );
    }
    return artifact;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export async function listSourceArtifacts(
  options: ServiceOptions = {},
): Promise<SourceArtifact[]> {
  const config = await loadConfig(options.root);
  const sources: SourceArtifact[] = [];
  for (const filePath of await walkFiles(config.sourcesDir, ".json")) {
    const artifact = parseSourceArtifact(
      JSON.parse(await readFile(filePath, "utf8")),
    );
    const fileId = path.basename(filePath, ".json");
    if (artifact.id !== fileId) {
      throw new Error(
        `Source filename mismatch: ${fileId} contains ${artifact.id}`,
      );
    }
    sources.push(artifact);
  }
  return sources.sort((left, right) => left.id.localeCompare(right.id));
}

export function parseSourceArtifact(value: unknown): SourceArtifact {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.id) ||
    !("hash" in value) ||
    value.hash !== value.id ||
    !("title" in value) ||
    typeof value.title !== "string" ||
    !("mediaType" in value) ||
    typeof value.mediaType !== "string" ||
    !("content" in value) ||
    typeof value.content !== "string" ||
    !("provenance" in value) ||
    typeof value.provenance !== "object" ||
    value.provenance === null ||
    !("provenanceHistory" in value) ||
    !Array.isArray(value.provenanceHistory) ||
    !("ingestedAt" in value) ||
    typeof value.ingestedAt !== "string"
  ) {
    throw new Error("Invalid SourceArtifact");
  }
  if (sha256(value.content) !== value.id) {
    throw new Error(`SourceArtifact content hash mismatch: ${value.id}`);
  }
  return value as SourceArtifact;
}

function validateSourceId(sourceId: string): void {
  if (!/^[a-f0-9]{64}$/.test(sourceId)) {
    throw new Error(`Invalid Source ID: ${sourceId}`);
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
