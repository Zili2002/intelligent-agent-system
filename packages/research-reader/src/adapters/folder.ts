import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { literatureAdapterRegistry } from "./registry.js";
import type { AdapterItem, AdapterResult, LiteratureAdapter } from "./types.js";

const MEDIA_TYPES = new Map([
  [".pdf", "application/pdf"],
  [".md", "text/markdown"],
  [".txt", "text/plain"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".json", "application/json"],
]);

export class FolderAdapter implements LiteratureAdapter {
  readonly name = "folder";

  async import(input: {
    source: string;
    root: string;
    limit?: number;
  }): Promise<AdapterResult> {
    const source = path.resolve(input.source);
    const file = await stat(source).catch(() => undefined);
    if (!file) throw new Error(`Folder adapter source not found: ${source}`);
    const files = file.isDirectory()
      ? await walk(source)
      : file.isFile()
        ? [source]
        : [];
    const limit = input.limit ?? 1_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error("Folder adapter limit must be from 1 to 10000");
    }
    const warnings: string[] = [];
    const items: AdapterItem[] = [];
    for (const filePath of files.sort().slice(0, limit)) {
      const extension = path.extname(filePath).toLowerCase();
      const mediaType = MEDIA_TYPES.get(extension);
      if (!mediaType) {
        warnings.push(`Skipped unsupported file: ${filePath}`);
        continue;
      }
      const title = path.basename(filePath, extension);
      items.push({
        metadata: {
          id: pathToFileURL(filePath).href,
          title,
          url: pathToFileURL(filePath).href,
          provider: this.name,
        },
        filePath,
        mediaType,
        evidenceKind: "full-text",
        ...(mediaType === "application/pdf"
          ? {}
          : { content: await readFile(filePath, "utf8") }),
      });
    }
    if (files.length > limit) {
      warnings.push(
        `Stopped after ${limit} files; ${files.length - limit} were not processed`,
      );
    }
    return { items, warnings };
  }
}

async function walk(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

literatureAdapterRegistry.register(new FolderAdapter());
