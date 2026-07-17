import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { literatureAdapterRegistry } from "./registry.js";
import type { AdapterItem, AdapterResult, LiteratureAdapter } from "./types.js";

export class ObsidianAdapter implements LiteratureAdapter {
  readonly name = "obsidian";

  async import(input: {
    source: string;
    root: string;
    limit?: number;
  }): Promise<AdapterResult> {
    const vault = path.resolve(input.source);
    if (!(await stat(vault)).isDirectory()) {
      throw new Error("Obsidian adapter source must be a directory");
    }
    const files = (await markdownFiles(vault)).slice(0, input.limit ?? 1_000);
    const items: AdapterItem[] = [];
    for (const filePath of files) {
      const content = await readFile(filePath, "utf8");
      const frontmatter = parseFrontmatter(content);
      items.push({
        metadata: {
          id: pathToFileURL(filePath).href,
          title:
            frontmatter.title ??
            path.basename(filePath, path.extname(filePath)),
          url: pathToFileURL(filePath).href,
          provider: this.name,
        },
        filePath,
        content,
        mediaType: "text/markdown",
        evidenceKind: "note",
        ...(frontmatter.tags.length
          ? { note: `Obsidian tags: ${frontmatter.tags.join(", ")}` }
          : {}),
      });
    }
    return { items, warnings: [] };
  }
}

async function markdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".obsidian") continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(target)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(target);
    }
  }
  return files.sort();
}

function parseFrontmatter(content: string): {
  title?: string;
  tags: string[];
} {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { tags: [] };
  const lines = match[1]!.split(/\r?\n/);
  const title = lines
    .find((line) => /^title\s*:/i.test(line))
    ?.replace(/^title\s*:\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  const tagLine = lines.find((line) => /^tags\s*:/i.test(line));
  const tags = tagLine
    ? tagLine
        .replace(/^tags\s*:\s*/i, "")
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((tag) => tag.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean)
    : [];
  return { ...(title ? { title } : {}), tags };
}

literatureAdapterRegistry.register(new ObsidianAdapter());
