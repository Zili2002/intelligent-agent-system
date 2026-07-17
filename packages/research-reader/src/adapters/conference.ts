import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LiteratureMetadata } from "@intelligent-agent-system/llm-wiki-compiler";
import { literatureAdapterRegistry } from "./registry.js";
import type { AdapterResult, LiteratureAdapter } from "./types.js";

export class ConferenceAdapter implements LiteratureAdapter {
  readonly name = "conference";

  async import(input: {
    source: string;
    root: string;
    limit?: number;
  }): Promise<AdapterResult> {
    const value = JSON.parse(
      await readFile(path.resolve(input.source), "utf8"),
    ) as unknown;
    if (!Array.isArray(value)) {
      throw new Error("Conference adapter expects a JSON paper array");
    }
    const limit = input.limit ?? 1_000;
    const warnings: string[] = [];
    if (value.length > limit) {
      warnings.push(
        `Stopped after ${limit} conference item(s); ${value.length - limit} were not parsed`,
      );
    }
    const items = value.slice(0, limit).flatMap((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        warnings.push(`Skipped conference item ${index}: not an object`);
        return [];
      }
      const data = entry as Record<string, unknown>;
      if (
        typeof data.title !== "string" ||
        !data.title.trim() ||
        typeof data.url !== "string" ||
        !data.url.trim()
      ) {
        warnings.push(`Skipped conference item ${index}: title/url required`);
        return [];
      }
      const metadata: LiteratureMetadata = {
        id: typeof data.id === "string" ? data.id : `${data.url}#${index}`,
        title: data.title.trim(),
        url: data.url.trim(),
        provider: this.name,
        ...(typeof data.venue === "string" ? { venue: data.venue } : {}),
        ...(typeof data.year === "number" && Number.isInteger(data.year)
          ? { year: data.year }
          : {}),
        ...(Array.isArray(data.authors) &&
        data.authors.every((author) => typeof author === "string")
          ? { authors: data.authors }
          : {}),
      };
      return [
        {
          metadata,
          ...(typeof data.abstract === "string" && data.abstract.trim()
            ? {
                content: `# ${metadata.title}\n\n## Abstract\n\n${data.abstract.trim()}`,
                mediaType: "text/markdown",
                evidenceKind: "abstract" as const,
              }
            : {}),
        },
      ];
    });
    return { items, warnings };
  }
}

literatureAdapterRegistry.register(new ConferenceAdapter());
