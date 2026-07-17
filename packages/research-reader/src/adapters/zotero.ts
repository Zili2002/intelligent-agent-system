import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  normalizeDoi,
  type LiteratureMetadata,
} from "@intelligent-agent-system/llm-wiki-compiler";
import { literatureAdapterRegistry } from "./registry.js";
import type { AdapterResult, LiteratureAdapter } from "./types.js";

interface ZoteroItem {
  id?: string;
  title?: string;
  URL?: string;
  url?: string;
  DOI?: string;
  doi?: string;
  abstract?: string;
  abstractNote?: string;
  containerTitle?: string;
  publicationTitle?: string;
  issued?: { "date-parts"?: number[][] };
  date?: string;
  author?: Array<{ given?: string; family?: string; literal?: string }>;
  creators?: Array<{
    firstName?: string;
    lastName?: string;
    name?: string;
  }>;
}

export class ZoteroAdapter implements LiteratureAdapter {
  readonly name = "zotero";

  async import(input: {
    source: string;
    root: string;
    limit?: number;
  }): Promise<AdapterResult> {
    const filePath = path.resolve(input.source);
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    const values = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" &&
          parsed !== null &&
          "items" in parsed &&
          Array.isArray(parsed.items)
        ? parsed.items
        : undefined;
    if (!values) throw new Error("Zotero adapter expects a JSON item array");
    const limit = input.limit ?? 1_000;
    const warnings: string[] = [];
    if (values.length > limit) {
      warnings.push(
        `Stopped after ${limit} Zotero item(s); ${values.length - limit} were not parsed`,
      );
    }
    const items = values.slice(0, limit).flatMap((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        warnings.push(`Skipped Zotero item ${index}: not an object`);
        return [];
      }
      const item = value as ZoteroItem;
      if (!item.title?.trim()) {
        warnings.push(`Skipped Zotero item ${index}: missing title`);
        return [];
      }
      const doi = normalizeDoi(item.DOI ?? item.doi);
      const url =
        item.URL ??
        item.url ??
        (doi ? `https://doi.org/${doi}` : `urn:zotero:${item.id ?? index}`);
      const year =
        item.issued?.["date-parts"]?.[0]?.[0] ??
        Number(item.date?.match(/\b(19|20)\d{2}\b/)?.[0]);
      const authors = [
        ...(item.author ?? []).map(
          (author) =>
            author.literal ??
            [author.given, author.family].filter(Boolean).join(" "),
        ),
        ...(item.creators ?? []).map(
          (creator) =>
            creator.name ??
            [creator.firstName, creator.lastName].filter(Boolean).join(" "),
        ),
      ].filter(Boolean);
      const metadata: LiteratureMetadata = {
        id: item.id ?? doi ?? url,
        title: item.title.trim(),
        url,
        provider: this.name,
        ...(doi ? { doi } : {}),
        ...(authors.length ? { authors } : {}),
        ...(Number.isInteger(year) ? { year } : {}),
        ...((item.containerTitle ?? item.publicationTitle)
          ? { venue: item.containerTitle ?? item.publicationTitle }
          : {}),
      };
      const abstract = item.abstract ?? item.abstractNote;
      return [
        {
          metadata,
          ...(abstract?.trim()
            ? {
                content: `# ${metadata.title}\n\n## Abstract\n\n${abstract.trim()}`,
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

literatureAdapterRegistry.register(new ZoteroAdapter());
