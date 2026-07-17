import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  atomicWriteJson,
  readJsonIfExists,
  withFileLock,
} from "@intelligent-agent/shared";
import {
  findEvidenceAnchor,
  getSourceArtifact,
} from "@intelligent-agent-system/llm-wiki-compiler";
import { loadPaperPassport } from "./store.js";
import type { PaperAnnotation, ResolvedReaderConfig } from "./types.js";

interface AnnotationArtifact {
  version: 1;
  items: PaperAnnotation[];
}

export async function addPaperAnnotation(
  config: ResolvedReaderConfig,
  paperId: string,
  input: {
    page?: number;
    selectedQuote?: string;
    drawingDataUrl?: string;
    voiceTranscript?: string;
    note: string;
  },
  now = new Date(),
): Promise<PaperAnnotation> {
  if (!input.note.trim()) throw new Error("Annotation note must not be empty");
  if (
    input.page !== undefined &&
    (!Number.isInteger(input.page) || input.page < 1)
  ) {
    throw new Error("Annotation page must be a positive integer");
  }
  if (
    input.drawingDataUrl !== undefined &&
    (!input.drawingDataUrl.startsWith("data:image/png;base64,") ||
      input.drawingDataUrl.length > 1_500_000)
  ) {
    throw new Error("Annotation drawing must be a bounded PNG data URL");
  }
  const paper = await loadPaperPassport(config, paperId);
  if (!paper) throw new Error(`Paper not found: ${paperId}`);
  if (input.selectedQuote) {
    const sourceId = paper.acquisition.fullTextSourceId;
    if (!sourceId) {
      throw new Error("Selected-quote annotations require acquired full text");
    }
    const source = await getSourceArtifact(sourceId, { root: config.root });
    if (!source) throw new Error(`Full-text source not found: ${sourceId}`);
    const anchor = findEvidenceAnchor(source, input.selectedQuote);
    if (input.page !== undefined && anchor.page !== input.page) {
      throw new Error("Annotation page does not match the selected quote");
    }
  }
  const timestamp = now.toISOString();
  const annotation: PaperAnnotation = {
    version: 1,
    id: `annotation-${randomUUID()}`,
    paperId,
    ...(paper.lifecycle.latestVersionId
      ? { sourceVersion: paper.lifecycle.latestVersionId }
      : {}),
    ...(input.page === undefined ? {} : { page: input.page }),
    ...(input.selectedQuote ? { selectedQuote: input.selectedQuote } : {}),
    ...(input.drawingDataUrl ? { drawingDataUrl: input.drawingDataUrl } : {}),
    ...(input.voiceTranscript?.trim()
      ? { voiceTranscript: input.voiceTranscript.trim() }
      : {}),
    note: input.note.trim(),
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const filePath = annotationsPath(config, paperId);
  await withFileLock(`${filePath}.lock`, async () => {
    const artifact =
      (await readJsonIfExists(filePath, parseAnnotations)) ??
      ({ version: 1, items: [] } satisfies AnnotationArtifact);
    artifact.items.push(annotation);
    await atomicWriteJson(filePath, artifact);
  });
  return annotation;
}

export async function listPaperAnnotations(
  config: ResolvedReaderConfig,
  paperId: string,
): Promise<PaperAnnotation[]> {
  const paper = await loadPaperPassport(config, paperId);
  if (!paper) throw new Error(`Paper not found: ${paperId}`);
  const filePath = annotationsPath(config, paperId);
  return withFileLock(`${filePath}.lock`, async () => {
    const artifact = await readJsonIfExists(filePath, parseAnnotations);
    if (!artifact) return [];
    let changed = false;
    for (const annotation of artifact.items) {
      if (
        annotation.sourceVersion &&
        paper.lifecycle.latestVersionId &&
        annotation.sourceVersion !== paper.lifecycle.latestVersionId &&
        annotation.status !== "needs-remap"
      ) {
        annotation.status = "needs-remap";
        annotation.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await atomicWriteJson(filePath, artifact);
    return artifact.items;
  });
}

function annotationsPath(
  config: ResolvedReaderConfig,
  paperId: string,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(paperId)) {
    throw new Error(`Invalid Paper ID: ${paperId}`);
  }
  return path.join(config.annotationsDir, `${paperId}.json`);
}

function parseAnnotations(value: unknown): AnnotationArtifact {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("items" in value) ||
    !Array.isArray(value.items)
  ) {
    throw new Error("Invalid Reader annotation artifact");
  }
  return value as AnnotationArtifact;
}
