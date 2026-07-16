import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  IngestOptions,
  RawManifest,
  RawManifestEntry,
  RawManifestOrigin,
  RawManifestStatus,
  ResolvedWikiConfig,
  ServiceOptions,
  SourceArtifact,
  SourceProvenance,
} from "./types.js";
import { loadConfig } from "./config.js";
import {
  readTextIfExists,
  sha256,
  slugify,
  walkFiles,
  writeText,
} from "./utils.js";

export const RAW_MANIFEST_FILE = "manifest.json";

export function validateStorageUri(storageUri: string): void {
  storageMode(storageUri);
}

export async function loadRawManifest(
  options: ServiceOptions = {},
): Promise<RawManifest> {
  const config = await loadConfig(options.root);
  return loadRawManifestForConfig(config);
}

export async function getRawManifestStatus(
  options: ServiceOptions = {},
): Promise<RawManifestStatus> {
  const config = await loadConfig(options.root);
  const manifest = await loadRawManifestForConfig(config);
  let existing = 0;
  let restorable = 0;
  let unavailable = 0;

  for (const entry of manifest.entries) {
    const hasExisting = await entryHasExistingRaw(config, entry);
    if (hasExisting) {
      existing += 1;
    } else if (
      entry.origins.some(
        (origin) =>
          origin.restoreMode === "download" || origin.restoreMode === "copy",
      )
    ) {
      restorable += 1;
    } else {
      unavailable += 1;
    }
  }

  return {
    path: path.join(config.rawDir, RAW_MANIFEST_FILE),
    entries: manifest.entries.length,
    restorable,
    existing,
    unavailable,
  };
}

export async function recordRawManifest(
  config: ResolvedWikiConfig,
  artifact: SourceArtifact,
  provenance: SourceProvenance,
  options: IngestOptions & ServiceOptions,
): Promise<void> {
  const manifest = await loadRawManifestForConfig(config);
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const originalData = options.originalData
    ? Buffer.from(options.originalData)
    : undefined;
  const origin = buildOrigin(
    config,
    artifact,
    provenance,
    options,
    originalData,
    timestamp,
  );
  let entry = manifest.entries.find(
    (candidate) => candidate.sourceId === artifact.id,
  );
  if (!entry) {
    entry = {
      sourceId: artifact.id,
      title: artifact.title,
      mediaType: artifact.mediaType,
      normalizedSha256: artifact.hash,
      origins: [],
    };
    manifest.entries.push(entry);
  }
  const key = originKey(origin);
  const originIndex = entry.origins.findIndex(
    (candidate) => originKey(candidate) === key,
  );
  if (originIndex < 0) {
    entry.origins.push(origin);
  } else {
    entry.origins[originIndex] = {
      ...entry.origins[originIndex],
      ...origin,
    };
  }
  entry.title = artifact.title;
  entry.mediaType = artifact.mediaType;
  manifest.updatedAt = timestamp;
  manifest.entries.sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId),
  );
  await saveRawManifest(config, manifest);
}

export async function initializeRawManifest(
  config: ResolvedWikiConfig,
): Promise<void> {
  const filePath = path.join(config.rawDir, RAW_MANIFEST_FILE);
  if ((await readTextIfExists(filePath)) !== undefined) return;
  await saveRawManifest(config, emptyManifest());
}

export async function backfillRawManifest(
  config: ResolvedWikiConfig,
): Promise<void> {
  const manifest = await loadRawManifestForConfig(config);
  let upgraded = false;
  for (const entry of manifest.entries) {
    for (const origin of entry.origins) {
      if (
        origin.restoreMode === "none" &&
        origin.kind === "search" &&
        origin.url &&
        origin.originalSha256 &&
        /^(?:application\/pdf|text\/html|text\/plain|application\/xml)$/.test(
          entry.mediaType,
        )
      ) {
        const fileName =
          origin.fileName ??
          `${slugify(entry.title)}${extensionForMediaType(entry.mediaType)}`;
        origin.fileName = safeFileName(fileName);
        origin.targetPath = path.posix.join(
          "restored",
          `${entry.sourceId.slice(0, 8)}-${origin.fileName}`,
        );
        origin.restoreMode = "download";
        upgraded = true;
      }
    }
  }
  if (upgraded) {
    manifest.updatedAt = new Date().toISOString();
    await saveRawManifest(config, manifest);
  }
  const known = new Set(manifest.entries.map((entry) => entry.sourceId));
  for (const file of await walkFiles(config.sourcesDir, ".json")) {
    const artifact = JSON.parse(await readFile(file, "utf8")) as SourceArtifact;
    if (known.has(artifact.id)) continue;
    for (const provenance of artifact.provenanceHistory?.length
      ? artifact.provenanceHistory
      : [artifact.provenance]) {
      await recordRawManifest(config, artifact, provenance, {
        mediaType: artifact.mediaType,
      });
    }
    known.add(artifact.id);
  }
}

async function loadRawManifestForConfig(
  config: ResolvedWikiConfig,
): Promise<RawManifest> {
  const filePath = path.join(config.rawDir, RAW_MANIFEST_FILE);
  const content = await readTextIfExists(filePath);
  if (content === undefined) return emptyManifest();
  const parsed = JSON.parse(content) as Partial<RawManifest>;
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`Invalid raw manifest: ${filePath}`);
  }
  return {
    version: 1,
    updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
    entries: parsed.entries as RawManifestEntry[],
  };
}

async function saveRawManifest(
  config: ResolvedWikiConfig,
  manifest: RawManifest,
): Promise<void> {
  await writeText(
    path.join(config.rawDir, RAW_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2),
  );
}

function emptyManifest(): RawManifest {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    entries: [],
  };
}

function buildOrigin(
  config: ResolvedWikiConfig,
  artifact: SourceArtifact,
  provenance: SourceProvenance,
  options: IngestOptions & ServiceOptions,
  originalData: Buffer | undefined,
  capturedAt: string,
): RawManifestOrigin {
  const fileName = safeFileName(
    options.fileName ??
      fileNameFromInput(provenance.url ?? provenance.input) ??
      `${slugify(artifact.title)}${extensionForMediaType(artifact.mediaType)}`,
  );
  const existingRelativePath =
    provenance.kind === "file"
      ? relativeRawPath(config.rawDir, provenance.input)
      : undefined;
  const storageUri = options.storageUri ?? provenance.storageUri;
  const restoreMode =
    existingRelativePath !== undefined
      ? "existing"
      : storageUri
        ? storageMode(storageUri)
        : (provenance.kind === "url" ||
              (provenance.kind === "search" && originalData)) &&
            provenance.url
          ? "download"
          : "none";
  const targetPath =
    restoreMode === "none"
      ? undefined
      : (existingRelativePath ??
        path.posix.join("restored", `${artifact.id.slice(0, 8)}-${fileName}`));

  return {
    kind: provenance.kind,
    input: provenance.input,
    ...(provenance.url ? { url: provenance.url } : {}),
    ...(provenance.provider ? { provider: provenance.provider } : {}),
    ...(storageUri ? { storageUri } : {}),
    ...(fileName ? { fileName } : {}),
    ...(targetPath ? { targetPath } : {}),
    ...(originalData ? { originalSha256: sha256(originalData) } : {}),
    ...(originalData ? { sizeBytes: originalData.byteLength } : {}),
    capturedAt,
    restoreMode,
  };
}

function relativeRawPath(rawDir: string, input: string): string | undefined {
  const absoluteInput = path.resolve(input);
  const relative = path.relative(rawDir, absoluteInput);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  ) {
    return relative.split(path.sep).join("/");
  }
  return undefined;
}

function storageMode(storageUri: string): "download" | "copy" {
  if (/^https?:\/\//i.test(storageUri)) return "download";
  if (storageUri.startsWith("file:") || path.isAbsolute(storageUri)) {
    return "copy";
  }
  throw new Error(
    "storageUri must be an HTTP(S) URL, file URL, or absolute file path",
  );
}

function fileNameFromInput(input: string): string | undefined {
  try {
    if (/^https?:\/\//i.test(input)) {
      return path.posix.basename(new URL(input).pathname) || undefined;
    }
  } catch {
    return undefined;
  }
  return path.basename(input) || undefined;
}

function safeFileName(value: string): string {
  const base = path.basename(value).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-");
  return base.slice(0, 180) || "source.bin";
}

function extensionForMediaType(mediaType: string): string {
  const extensions: Record<string, string> = {
    "application/pdf": ".pdf",
    "application/json": ".json",
    "text/html": ".html",
    "text/markdown": ".md",
    "text/plain": ".txt",
  };
  return extensions[mediaType] ?? ".bin";
}

function originKey(origin: RawManifestOrigin): string {
  return JSON.stringify({
    kind: origin.kind,
    input: origin.input,
    url: origin.url,
    storageUri: origin.storageUri,
    originalSha256: origin.originalSha256,
  });
}

async function entryHasExistingRaw(
  config: ResolvedWikiConfig,
  entry: RawManifestEntry,
): Promise<boolean> {
  for (const origin of entry.origins) {
    if (!origin.targetPath) continue;
    try {
      await access(safeRawTarget(config.rawDir, origin.targetPath));
      return true;
    } catch {}
  }
  return false;
}

export function safeRawTarget(rawDir: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`Raw target path must be relative: ${relativePath}`);
  }
  const target = path.resolve(rawDir, relativePath);
  const relative = path.relative(rawDir, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Raw target escapes raw directory: ${relativePath}`);
  }
  return target;
}
