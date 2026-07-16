import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { recordRawManifest, validateStorageUri } from "./manifest.js";
import type {
  IngestOptions,
  IngestResult,
  ServiceOptions,
  SourceArtifact,
  SourceProvenance,
} from "./types.js";
import {
  htmlToText,
  isFile,
  normalizeText,
  sha256,
  writeText,
} from "./utils.js";

const TEXT_EXTENSIONS = new Map([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".json", "application/json"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".pdf", "application/pdf"],
]);

function titleFromContent(content: string, fallback: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return (heading || fallback).slice(0, 200);
}

function normalizeByMediaType(content: string, mediaType: string): string {
  if (mediaType.includes("html")) return htmlToText(content);
  if (mediaType.includes("json")) {
    try {
      return normalizeText(JSON.stringify(JSON.parse(content), null, 2));
    } catch (error) {
      throw new Error(`Malformed JSON input: ${(error as Error).message}`);
    }
  }
  return normalizeText(content);
}

async function parsePdf(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    return normalizeText((await parser.getText()).text);
  } finally {
    await parser.destroy();
  }
}

function mergeLiterature(
  existing: NonNullable<SourceArtifact["literature"]>,
  incoming: NonNullable<SourceArtifact["literature"]>,
): NonNullable<SourceArtifact["literature"]> {
  const providers = [
    ...new Set([
      existing.provider,
      ...(existing.providers ?? []),
      incoming.provider,
      ...(incoming.providers ?? []),
    ]),
  ];
  const sourceProvenance = [
    ...(existing.sourceProvenance ?? []),
    ...(incoming.sourceProvenance ?? []),
  ].filter(
    (entry, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.provider === entry.provider &&
          candidate.id === entry.id &&
          candidate.url === entry.url,
      ) === index,
  );
  return {
    ...existing,
    ...incoming,
    provider: existing.provider,
    providers,
    ...(Math.max(existing.citationCount ?? 0, incoming.citationCount ?? 0) > 0
      ? {
          citationCount: Math.max(
            existing.citationCount ?? 0,
            incoming.citationCount ?? 0,
          ),
        }
      : {}),
    ...(sourceProvenance.length ? { sourceProvenance } : {}),
  };
}

export async function ingestContent(
  content: string,
  input: string,
  options: IngestOptions & ServiceOptions = {},
): Promise<IngestResult> {
  const config = await loadConfig(options.root);
  if (options.storageUri) validateStorageUri(options.storageUri);
  const mediaType = options.mediaType ?? "text/plain";
  const normalized = normalizeByMediaType(content, mediaType);
  if (!normalized)
    throw new Error(`Input contains no usable content: ${input}`);
  const hash = sha256(normalized);
  const artifactPath = path.join(config.sourcesDir, `${hash}.json`);
  const provenance: SourceProvenance = {
    kind: options.provenanceKind ?? "file",
    input,
    ...(options.url ? { url: options.url } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.storageUri ? { storageUri: options.storageUri } : {}),
  };
  const existing = await readFile(artifactPath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (existing) {
    const artifact = JSON.parse(existing) as SourceArtifact;
    artifact.provenanceHistory ??= [artifact.provenance];
    let changed = false;
    if (options.literature) {
      const merged = artifact.literature
        ? mergeLiterature(artifact.literature, options.literature)
        : options.literature;
      if (JSON.stringify(artifact.literature) !== JSON.stringify(merged)) {
        artifact.literature = merged;
        changed = true;
      }
    }
    const provenanceKey = JSON.stringify(provenance);
    if (
      !artifact.provenanceHistory.some(
        (entry) => JSON.stringify(entry) === provenanceKey,
      )
    ) {
      artifact.provenanceHistory.push(provenance);
      changed = true;
    }
    if (changed)
      await writeText(artifactPath, JSON.stringify(artifact, null, 2));
    await recordRawManifest(config, artifact, provenance, options);
    return {
      artifact,
      path: artifactPath,
      deduplicated: true,
    };
  }
  const fallbackTitle =
    path.basename(input, path.extname(input)) || "Untitled source";
  const artifact: SourceArtifact = {
    version: 1,
    id: hash,
    hash,
    title: options.title?.trim() || titleFromContent(normalized, fallbackTitle),
    mediaType,
    content: normalized,
    provenance,
    provenanceHistory: [provenance],
    ...(options.literature ? { literature: options.literature } : {}),
    ingestedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  await writeText(artifactPath, JSON.stringify(artifact, null, 2));
  await recordRawManifest(config, artifact, provenance, options);
  return { artifact, path: artifactPath, deduplicated: false };
}

/** Ingest downloaded bytes while retaining their original hash in the raw manifest. */
export async function ingestBytes(
  data: Uint8Array,
  input: string,
  options: IngestOptions & ServiceOptions = {},
): Promise<IngestResult> {
  const mediaType = options.mediaType ?? "text/plain";
  const originalData = Buffer.from(data);
  if (mediaType === "application/pdf") {
    return ingestContent(await parsePdf(originalData), input, {
      ...options,
      mediaType,
      originalData,
    });
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(originalData);
  } catch (error) {
    throw new Error(
      `Input is not valid UTF-8: ${input}: ${(error as Error).message}`,
    );
  }
  return ingestContent(content, input, { ...options, mediaType, originalData });
}

export async function ingest(
  input: string,
  options: IngestOptions & ServiceOptions = {},
): Promise<IngestResult> {
  if (!input.trim()) throw new Error("Input path or URL is required");
  if (/^https?:\/\//i.test(input)) {
    const fetcher = options.fetch ?? globalThis.fetch;
    if (!fetcher)
      throw new Error("No fetch implementation is available for URL ingestion");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetcher(input, {
        headers: { "user-agent": "llm-wiki-compiler/0.2" },
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(`Failed to fetch ${input}: HTTP ${response.status}`);
      const mediaType =
        response.headers.get("content-type")?.split(";")[0]?.trim() ||
        "text/plain";
      const sourceFileName = options.fileName ?? fileNameFromUrl(input);
      if (!/^(text\/|application\/(json|xhtml\+xml))/i.test(mediaType)) {
        if (mediaType !== "application/pdf") {
          throw new Error(`Unsupported URL media type: ${mediaType}`);
        }
      }
      return ingestBytes(new Uint8Array(await response.arrayBuffer()), input, {
        ...options,
        mediaType,
        provenanceKind: "url",
        url: input,
        ...(sourceFileName ? { fileName: sourceFileName } : {}),
      });
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(`Timed out fetching URL after 30 seconds: ${input}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const filePath = path.resolve(options.root ?? process.cwd(), input);
  if (!(await isFile(filePath)))
    throw new Error(`Input file not found: ${filePath}`);
  const extension = path.extname(filePath).toLowerCase();
  const mediaType = TEXT_EXTENSIONS.get(extension);
  if (!mediaType)
    throw new Error(`Unsupported input type "${extension || "(none)"}"`);
  const originalData = await readFile(filePath);
  return ingestBytes(originalData, filePath, {
    ...options,
    mediaType,
    fileName: options.fileName ?? path.basename(filePath),
  });
}

function fileNameFromUrl(input: string): string | undefined {
  try {
    return path.posix.basename(new URL(input).pathname) || undefined;
  } catch {
    return undefined;
  }
}
