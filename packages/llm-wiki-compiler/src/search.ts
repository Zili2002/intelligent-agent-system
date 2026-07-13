import { ingestContent } from "./ingest.js";
import { loadConfig } from "./config.js";
import type {
  SearchOptions,
  SearchProvider,
  SearchResult,
  SearchRun,
  ServiceOptions,
} from "./types.js";
import { htmlToText, normalizeText } from "./utils.js";

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  URL?: string;
  abstract?: string;
  author?: Array<{ given?: string; family?: string }>;
  published?: { "date-parts"?: number[][] };
  "container-title"?: string[];
}

interface CrossrefResponse {
  message?: { items?: CrossrefItem[] };
}

export class CrossrefProvider implements SearchProvider {
  readonly name = "crossref";
  readonly #fetch: typeof globalThis.fetch;

  constructor(fetcher: typeof globalThis.fetch = globalThis.fetch) {
    if (!fetcher)
      throw new Error("Crossref search requires a fetch implementation");
    this.#fetch = fetcher;
  }

  async search(
    query: string,
    options: { limit: number; signal?: AbortSignal },
  ): Promise<SearchResult[]> {
    const url = new URL("https://api.crossref.org/works");
    url.searchParams.set("query", query);
    url.searchParams.set("rows", String(Math.min(options.limit * 5, 100)));
    url.searchParams.set(
      "select",
      "DOI,title,URL,abstract,author,published,container-title",
    );
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await this.#fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "llm-wiki-compiler/0.2",
        },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (response.status !== 429 && response.status < 500) break;
      if (attempt === 0) {
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const delay =
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
            ? Math.min(retryAfterSeconds * 1_000, 2_000)
            : 250;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    if (!response?.ok)
      throw new Error(
        `Crossref search failed: HTTP ${response?.status ?? "unknown"}`,
      );
    const data = (await response.json()) as CrossrefResponse;
    return (data.message?.items ?? [])
      .map((item): SearchResult | undefined => {
        const title = item.title?.[0]?.trim();
        const resultUrl =
          item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : undefined);
        if (!title || !resultUrl) return undefined;
        const abstract = item.abstract ? htmlToText(item.abstract) : undefined;
        const container = item["container-title"]?.[0];
        const published = item.published?.["date-parts"]?.[0]
          ?.filter((part) => part !== undefined)
          .join("-");
        const authors = item.author
          ?.map((author) =>
            [author.given, author.family].filter(Boolean).join(" "),
          )
          .filter(Boolean);
        return {
          id: item.DOI ?? resultUrl,
          title,
          url: resultUrl,
          ...(abstract ? { abstract } : {}),
          ...(abstract ? { snippet: abstract.slice(0, 500) } : {}),
          ...(container ? { venue: container } : {}),
          ...(published ? { published } : {}),
          ...(authors?.length ? { authors } : {}),
          provider: this.name,
        };
      })
      .filter((result): result is SearchResult => result !== undefined)
      .slice(0, options.limit);
  }
}

function evidenceText(result: SearchResult): string {
  const lines = [
    `# ${result.title}`,
    `Provider: ${result.provider}`,
    `URL: ${result.url}`,
    result.authors?.length
      ? `Authors: ${result.authors.join(", ")}`
      : undefined,
    result.published ? `Published: ${result.published}` : undefined,
    result.venue ? `Venue: ${result.venue}` : undefined,
    result.abstract ? `Abstract:\n${result.abstract}` : undefined,
    !result.abstract && result.snippet
      ? `Snippet:\n${result.snippet}`
      : undefined,
  ].filter(Boolean);
  return normalizeText(lines.join("\n\n"));
}

export async function searchWiki(
  query: string,
  options: SearchOptions & ServiceOptions = {},
): Promise<SearchRun> {
  if (!query.trim()) throw new Error("Search query must not be empty");
  const config = await loadConfig(options.root);
  const limit = options.limit ?? config.search.resultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Search limit must be from 1 to 100");
  const provider =
    options.provider ?? new CrossrefProvider(options.fetch ?? globalThis.fetch);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let results: SearchResult[] = [];
  const errors: string[] = [];
  try {
    results = await provider.search(query, {
      limit,
      signal: controller.signal,
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
  const imported = [];
  if (options.importResults) {
    for (const result of results) {
      const content = evidenceText(result);
      if (!result.abstract && !result.snippet) {
        errors.push(
          `Skipped "${result.title}": search result contained no abstract or snippet evidence`,
        );
        continue;
      }
      imported.push(
        await ingestContent(content, result.url, {
          root: config.root,
          title: result.title,
          mediaType: "application/vnd.llmwiki.search-result+text",
          provenanceKind: "search",
          url: result.url,
          provider: result.provider,
          ...(options.now ? { now: options.now } : {}),
        }),
      );
    }
  }
  return { query, provider: provider.name, results, imported, errors };
}
