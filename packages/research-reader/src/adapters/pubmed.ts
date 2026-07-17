import { normalizeDoi } from "@intelligent-agent-system/llm-wiki-compiler";
import { literatureAdapterRegistry } from "./registry.js";
import type { AdapterResult, LiteratureAdapter } from "./types.js";

interface PubmedSearchResponse {
  esearchresult?: { idlist?: string[] };
}

interface PubmedSummaryItem {
  uid?: string;
  title?: string;
  pubdate?: string;
  fulljournalname?: string;
  elocationid?: string;
  authors?: Array<{ name?: string }>;
}

interface PubmedSummaryResponse {
  result?: {
    uids?: string[];
    [id: string]: PubmedSummaryItem | string[] | undefined;
  };
}

export class PubmedAdapter implements LiteratureAdapter {
  readonly name = "pubmed";

  async import(input: {
    source: string;
    root: string;
    approveNetwork?: boolean;
    fetch?: typeof globalThis.fetch;
    limit?: number;
  }): Promise<AdapterResult> {
    if (input.approveNetwork !== true) {
      throw new Error(
        "PubMed adapter requires explicit network approval (approveNetwork: true)",
      );
    }
    if (!input.source.trim()) throw new Error("PubMed query must not be empty");
    const fetcher = input.fetch ?? globalThis.fetch;
    if (!fetcher) throw new Error("PubMed adapter requires fetch");
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("PubMed adapter limit must be from 1 to 100");
    }
    const searchUrl = new URL(
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
    );
    searchUrl.searchParams.set("db", "pubmed");
    searchUrl.searchParams.set("retmode", "json");
    searchUrl.searchParams.set("retmax", String(limit));
    searchUrl.searchParams.set("term", input.source);
    const search = await fetchJson<PubmedSearchResponse>(fetcher, searchUrl);
    const ids = search.esearchresult?.idlist ?? [];
    if (!ids.length) return { items: [], warnings: [] };
    const summaryUrl = new URL(
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi",
    );
    summaryUrl.searchParams.set("db", "pubmed");
    summaryUrl.searchParams.set("retmode", "json");
    summaryUrl.searchParams.set("id", ids.join(","));
    const summary = await fetchJson<PubmedSummaryResponse>(fetcher, summaryUrl);
    const warnings: string[] = [];
    const items = ids.flatMap((id) => {
      const value = summary.result?.[id];
      if (!value || Array.isArray(value) || !value.title?.trim()) {
        warnings.push(`Skipped PubMed ${id}: incomplete summary`);
        return [];
      }
      const doi = normalizeDoi(value.elocationid?.replace(/^doi:\s*/i, ""));
      const year = Number(value.pubdate?.match(/\b(19|20)\d{2}\b/)?.[0]);
      return [
        {
          metadata: {
            id,
            title: value.title.trim(),
            url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
            provider: this.name,
            ...(doi ? { doi } : {}),
            ...(Number.isInteger(year) ? { year } : {}),
            ...(value.pubdate ? { published: value.pubdate } : {}),
            ...(value.fulljournalname ? { venue: value.fulljournalname } : {}),
            ...(value.authors?.length
              ? {
                  authors: value.authors
                    .map((author) => author.name)
                    .filter((name): name is string => Boolean(name)),
                }
              : {}),
          },
        },
      ];
    });
    return { items, warnings };
  }
}

async function fetchJson<T>(
  fetcher: typeof globalThis.fetch,
  url: URL,
): Promise<T> {
  const response = await fetcher(url, {
    headers: {
      accept: "application/json",
      "user-agent": "research-reader/0.1",
    },
  });
  if (!response.ok) {
    throw new Error(`PubMed request failed: HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

literatureAdapterRegistry.register(new PubmedAdapter());
