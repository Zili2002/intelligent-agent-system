import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { literatureAdapterRegistry } from "./registry.js";
import type { AdapterResult, LiteratureAdapter } from "./types.js";

export class LatexAdapter implements LiteratureAdapter {
  readonly name = "latex";

  async import(input: {
    source: string;
    root: string;
    limit?: number;
  }): Promise<AdapterResult> {
    const source = path.resolve(input.source);
    const sourceStat = await stat(source);
    const files = sourceStat.isDirectory()
      ? (await texFiles(source)).slice(0, input.limit ?? 1_000)
      : [source];
    const items = await Promise.all(
      files.map(async (filePath) => {
        const raw = await readFile(filePath, "utf8");
        const title =
          command(raw, "title") ??
          path.basename(filePath, path.extname(filePath));
        const authors = command(raw, "author")
          ?.split(/\\and|,/)
          .map((author) => strip(author).trim())
          .filter(Boolean);
        const date = command(raw, "date");
        const year = Number(date?.match(/\b(19|20)\d{2}\b/)?.[0]);
        return {
          metadata: {
            id: pathToFileURL(filePath).href,
            title: strip(title),
            url: pathToFileURL(filePath).href,
            provider: this.name,
            ...(authors?.length ? { authors } : {}),
            ...(Number.isInteger(year) ? { year } : {}),
          },
          filePath,
          content: normalizeLatex(raw),
          mediaType: "text/plain",
          evidenceKind: "full-text" as const,
        };
      }),
    );
    return { items, warnings: [] };
  }
}

async function texFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await texFiles(target)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".tex")) {
      files.push(target);
    }
  }
  return files.sort();
}

function command(content: string, name: string): string | undefined {
  return content.match(new RegExp(`\\\\${name}\\s*\\{([^}]*)\\}`, "s"))?.[1];
}

function normalizeLatex(value: string): string {
  return value
    .replace(/(?<!\\)%.*$/gm, "")
    .replace(
      /\\(?:section|subsection|subsubsection)\*?\{([^}]*)\}/g,
      "\n# $1\n",
    )
    .replace(/\\(?:textbf|textit|emph)\{([^}]*)\}/g, "$1")
    .replace(/\\cite\{([^}]*)\}/g, "[citation: $1]")
    .replace(/\\[A-Za-z]+\*?(?:\[[^\]]*\])?/g, " ")
    .replace(/[{}]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function strip(value: string): string {
  return value
    .replace(/\\[A-Za-z]+\*?/g, "")
    .replace(/[{}]/g, "")
    .trim();
}

literatureAdapterRegistry.register(new LatexAdapter());
