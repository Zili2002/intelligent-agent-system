import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import {
  loadRawManifest,
  RAW_MANIFEST_FILE,
  safeRawTarget,
} from "./manifest.js";
import type {
  RawManifestOrigin,
  RestoreRawItem,
  RestoreRawResult,
  ServiceOptions,
} from "./types.js";
import { sha256 } from "./utils.js";

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;

export interface RestoreRawOptions extends ServiceOptions {
  force?: boolean;
  maxFileBytes?: number;
}

export async function restoreRaw(
  options: RestoreRawOptions = {},
): Promise<RestoreRawResult> {
  const config = await loadConfig(options.root);
  const manifest = await loadRawManifest({ root: config.root });
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new Error("maxFileBytes must be a positive integer");
  }
  const items: RestoreRawItem[] = [];

  for (const entry of manifest.entries) {
    const origins = entry.origins.filter(
      (origin) => origin.restoreMode !== "none" && origin.targetPath,
    );
    if (origins.length === 0) {
      items.push({
        sourceId: entry.sourceId,
        status: "unavailable",
        message: "No restorable raw origin is recorded",
      });
      continue;
    }

    let completed = false;
    const errors: string[] = [];
    for (const origin of origins) {
      try {
        const item = await restoreOrigin(
          config.rawDir,
          entry.sourceId,
          origin,
          {
            force: options.force ?? false,
            maxFileBytes,
            fetch: options.fetch ?? globalThis.fetch,
          },
        );
        items.push(item);
        completed = true;
        break;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (!completed) {
      items.push({
        sourceId: entry.sourceId,
        status: "error",
        message: errors.join(" | "),
      });
    }
  }

  return {
    manifestPath: path.join(config.rawDir, RAW_MANIFEST_FILE),
    restored: items.filter((item) => item.status === "restored").length,
    verified: items.filter((item) => item.status === "verified").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    unavailable: items.filter((item) => item.status === "unavailable").length,
    errors: items.filter((item) => item.status === "error").length,
    items,
  };
}

async function restoreOrigin(
  rawDir: string,
  sourceId: string,
  origin: RawManifestOrigin,
  options: {
    force: boolean;
    maxFileBytes: number;
    fetch?: typeof globalThis.fetch;
  },
): Promise<RestoreRawItem> {
  if (!origin.targetPath) {
    return {
      sourceId,
      status: "unavailable",
      message: "Origin has no target raw path",
    };
  }
  const target = safeRawTarget(rawDir, origin.targetPath);
  const existing = await readExisting(target, options.maxFileBytes);
  if (existing) {
    if (!origin.originalSha256) {
      return {
        sourceId,
        status: "skipped",
        path: target,
        message:
          "Existing raw file was retained, but the legacy manifest has no original hash",
      };
    }
    if (sha256(existing) === origin.originalSha256) {
      return {
        sourceId,
        status: "verified",
        path: target,
        message: "Existing raw file matches the manifest",
      };
    }
    if (!options.force) {
      throw new Error(
        `Existing raw file hash mismatch for ${origin.targetPath}; use --force only after reviewing the source`,
      );
    }
  }

  const data = await readOrigin(origin, options);
  if (origin.originalSha256 && sha256(data) !== origin.originalSha256) {
    throw new Error(
      `Restored content hash mismatch for ${origin.targetPath}; source content changed`,
    );
  }
  await atomicWrite(target, data);
  return {
    sourceId,
    status: "restored",
    path: target,
    message: `Restored from ${origin.storageUri ?? origin.url ?? origin.input}`,
  };
}

async function readOrigin(
  origin: RawManifestOrigin,
  options: {
    maxFileBytes: number;
    fetch?: typeof globalThis.fetch;
  },
): Promise<Buffer> {
  const source = origin.storageUri ?? origin.url ?? origin.input;
  if (/^https?:\/\//i.test(source)) {
    if (!options.fetch) throw new Error("No fetch implementation is available");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await options.fetch(source, {
        headers: { "user-agent": "llm-wiki-compiler/0.3" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Failed to restore ${source}: HTTP ${response.status}`);
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(contentLength) &&
        contentLength > options.maxFileBytes
      ) {
        throw new Error(`Source exceeds ${options.maxFileBytes} byte limit`);
      }
      const data = Buffer.from(await response.arrayBuffer());
      enforceSize(data, options.maxFileBytes);
      return data;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Timed out restoring ${source} after 30 seconds`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const filePath = source.startsWith("file:")
    ? fileURLToPath(source)
    : path.resolve(source);
  const file = await stat(filePath);
  if (!file.isFile())
    throw new Error(`Restore source is not a file: ${filePath}`);
  if (file.size > options.maxFileBytes) {
    throw new Error(`Source exceeds ${options.maxFileBytes} byte limit`);
  }
  return readFile(filePath);
}

async function readExisting(
  filePath: string,
  maxFileBytes: number,
): Promise<Buffer | undefined> {
  try {
    const file = await stat(filePath);
    if (!file.isFile()) return undefined;
    if (file.size > maxFileBytes) {
      throw new Error(`Existing file exceeds ${maxFileBytes} byte limit`);
    }
    return readFile(filePath);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function atomicWrite(filePath: string, data: Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, filePath);
}

function enforceSize(data: Buffer, maxFileBytes: number): void {
  if (data.byteLength > maxFileBytes) {
    throw new Error(`Source exceeds ${maxFileBytes} byte limit`);
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
