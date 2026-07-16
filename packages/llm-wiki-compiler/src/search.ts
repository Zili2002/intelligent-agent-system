import { acquireFullText } from "./full-text.js";
import { ingestContent } from "./ingest.js";
import { loadConfig } from "./config.js";
import { LlmUsageTracker, requireLlm } from "./llm.js";
import { screenSearchCandidate } from "./screening.js";
import { searchProviderRegistry } from "./provider-registry.js";
import type {
  SearchOptions,
  SearchProvider,
  SearchResult,
  SearchRun,
  ServiceOptions,
  SourceArtifact,
} from "./types.js";
import { htmlToText, normalizeText } from "./utils.js";

async function upgradeSources(
  sourcesDir: string,
  sourceIds: string[] | undefined,
): Promise<SourceArtifact[]> {
  if (!sourceIds?.length) return [];
  return Promise.all(
    [...new Set(sourceIds)].map(async (sourceId) => {
      if (!/^[a-f0-9]{64}$/.test(sourceId)) {
        throw new Error(`Invalid upgrade Source ID: ${sourceId}`);
      }
      return JSON.parse(
        await readFile(path.join(sourcesDir, `${sourceId}.json`), "utf8"),
      ) as SourceArtifact;
    }),
  );
}

function matchesUpgradeSource(
  result: SearchResult,
  sources: SourceArtifact[],
): boolean {
  return sources.some((source) => {
    const metadata = source.literature;
    return (
      (normalizeDoi(metadata?.doi) &&
        normalizeDoi(metadata?.doi) === normalizeDoi(result.doi)) ||
      (normalizeArxivId(metadata?.arxivId) &&
        normalizeArxivId(metadata?.arxivId) ===
          normalizeArxivId(result.arxivId)) ||
      (normalizeOpenAlexId(metadata?.openAlexId) &&
        normalizeOpenAlexId(metadata?.openAlexId) ===
          normalizeOpenAlexId(result.openAlexId)) ||
      normalizeSearchTitle(metadata?.title ?? source.title) ===
        normalizeSearchTitle(result.title)
    );
  });
}

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
          ...(item.DOI ? { doi: item.DOI } : {}),
          ...(item.DOI
            ? {
                sourceProvenance: [
                  {
                    provider: this.name,
                    id: item.DOI,
                    url: resultUrl,
                  },
                ],
              }
            : {}),
        };
      })
      .filter((result): result is SearchResult => result !== undefined)
      .slice(0, options.limit);
  }
}

searchProviderRegistry.register(
  "crossref",
  (fetcher) => new CrossrefProvider(fetcher),
);

export function normalizeDoi(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .trim()
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .toLowerCase();
  return normalized || undefined;
}

export function normalizeArxivId(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .trim()
    .replace(/^arxiv:\s*/i, "")
    .replace(/^https?:\/\/arxiv\.org\/abs\//i, "")
    .replace(/v\d+$/i, "");
  return normalized || undefined;
}

export function normalizeOpenAlexId(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/^https?:\/\/openalex\.org\//i, "");
  return normalized ? normalized.toUpperCase() : undefined;
}

export function normalizeSearchTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function firstAuthor(result: SearchResult): string {
  return normalizeSearchTitle(result.authors?.[0] ?? "");
}

function resultKeys(result: SearchResult): string[] {
  const doi = normalizeDoi(
    result.doi ??
      (/^(?:10\.|doi:|https?:\/\/(?:dx\.)?doi\.org\/)/i.test(result.id)
        ? result.id
        : undefined),
  );
  const arxiv = normalizeArxivId(result.arxivId);
  const openAlex = normalizeOpenAlexId(result.openAlexId);
  if (doi || arxiv || openAlex) {
    return [
      ...(doi ? [`doi:${doi}`] : []),
      ...(arxiv ? [`arxiv:${arxiv}`] : []),
      ...(openAlex ? [`openalex:${openAlex}`] : []),
    ];
  }
  const year = result.year ?? Number(result.published?.slice(0, 4));
  const author = firstAuthor(result);
  return [
    ...(normalizeSearchTitle(result.title) && Number.isInteger(year) && author
      ? [`work:${normalizeSearchTitle(result.title)}:${year}:${author}`]
      : []),
  ];
}

function richer(
  first: string | undefined,
  second: string | undefined,
): string | undefined {
  return (second?.length ?? 0) > (first?.length ?? 0) ? second : first;
}

function mergePair(first: SearchResult, second: SearchResult): SearchResult {
  const providers = [
    ...new Set([
      first.provider,
      ...(first.providers ?? []),
      second.provider,
      ...(second.providers ?? []),
    ]),
  ];
  const locations = [
    ...(first.fullTextLocations ?? []),
    ...(second.fullTextLocations ?? []),
  ].filter(
    (location, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.url === location.url && candidate.kind === location.kind,
      ) === index,
  );
  const provenance = [
    ...(first.sourceProvenance ?? [
      { provider: first.provider, id: first.id, url: first.url },
    ]),
    ...(second.sourceProvenance ?? [
      { provider: second.provider, id: second.id, url: second.url },
    ]),
  ].filter(
    (entry, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.provider === entry.provider &&
          candidate.id === entry.id &&
          candidate.url === entry.url,
      ) === index,
  );
  const abstract = richer(first.abstract, second.abstract);
  const snippet = richer(first.snippet, second.snippet);
  const venue = richer(first.venue, second.venue);
  const doi = normalizeDoi(first.doi) ?? normalizeDoi(second.doi);
  const arxivId =
    normalizeArxivId(first.arxivId) ?? normalizeArxivId(second.arxivId);
  const openAlexId =
    normalizeOpenAlexId(first.openAlexId) ??
    normalizeOpenAlexId(second.openAlexId);
  const authors =
    (first.authors?.length ?? 0) >= (second.authors?.length ?? 0)
      ? first.authors
      : second.authors;
  const firstOpen = first.openAccess === true;
  const secondOpen = second.openAccess === true;
  return {
    ...first,
    providers,
    ...(doi ? { doi } : {}),
    ...(arxivId ? { arxivId } : {}),
    ...(openAlexId ? { openAlexId } : {}),
    ...(abstract ? { abstract } : {}),
    ...(snippet ? { snippet } : {}),
    ...(venue ? { venue } : {}),
    ...((first.published ?? second.published)
      ? { published: first.published ?? second.published }
      : {}),
    ...((first.year ?? second.year) ? { year: first.year ?? second.year } : {}),
    ...(authors?.length ? { authors } : {}),
    ...((first.versionId ?? second.versionId)
      ? { versionId: first.versionId ?? second.versionId }
      : {}),
    ...((first.sourceId ?? second.sourceId)
      ? { sourceId: first.sourceId ?? second.sourceId }
      : {}),
    ...((first.license ?? second.license)
      ? { license: first.license ?? second.license }
      : {}),
    ...(firstOpen || secondOpen
      ? { openAccess: true }
      : first.openAccess === false || second.openAccess === false
        ? { openAccess: false }
        : {}),
    ...((first.oaStatus ?? second.oaStatus)
      ? { oaStatus: first.oaStatus ?? second.oaStatus }
      : {}),
    ...(Math.max(first.citationCount ?? 0, second.citationCount ?? 0) > 0
      ? {
          citationCount: Math.max(
            first.citationCount ?? 0,
            second.citationCount ?? 0,
          ),
        }
      : {}),
    ...((first.workType ?? second.workType)
      ? { workType: first.workType ?? second.workType }
      : {}),
    ...(first.isRetracted === true || second.isRetracted === true
      ? { isRetracted: true }
      : first.isRetracted === false || second.isRetracted === false
        ? { isRetracted: false }
        : {}),
    ...(locations.length ? { fullTextLocations: locations } : {}),
    sourceProvenance: provenance,
  };
}

/** Deterministically collapse equivalent records while retaining all provenance. */
export function mergeSearchResults(results: SearchResult[]): SearchResult[] {
  const groups: SearchResult[] = [];
  for (const result of results) {
    const keys = resultKeys(result);
    const matches = groups
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) =>
        resultKeys(candidate).some((key) => keys.includes(key)),
      );
    if (!matches.length) {
      groups.push({
        ...result,
        ...(normalizeDoi(result.doi) ? { doi: normalizeDoi(result.doi)! } : {}),
        ...(normalizeArxivId(result.arxivId)
          ? { arxivId: normalizeArxivId(result.arxivId)! }
          : {}),
        ...(normalizeOpenAlexId(result.openAlexId)
          ? { openAlexId: normalizeOpenAlexId(result.openAlexId)! }
          : {}),
        providers: [...new Set([result.provider, ...(result.providers ?? [])])],
      });
      continue;
    }
    const first = matches[0]!;
    let merged = mergePair(first.candidate, result);
    for (const match of matches.slice(1).reverse()) {
      merged = mergePair(merged, match.candidate);
      groups.splice(match.index, 1);
    }
    groups[first.index] = merged;
  }
  return groups;
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

function normalizedDate(value: string, bound: "from" | "to"): string {
  const match = value.match(/^(\d{4})(?:-(\d{2})-(\d{2}))?$/);
  if (!match) throw new Error(`${bound} date must be YYYY or YYYY-MM-DD`);
  const year = Number(match[1]);
  const month =
    match[2] === undefined ? (bound === "from" ? 1 : 12) : Number(match[2]);
  const day =
    match[3] === undefined
      ? bound === "from"
        ? 1
        : new Date(Date.UTC(year, month, 0)).getUTCDate()
      : Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${bound} date must be a valid YYYY or YYYY-MM-DD date`);
  }
  return date.toISOString().slice(0, 10);
}

function resultDateRange(
  result: SearchResult,
): { from: string; to: string } | undefined {
  if (result.published?.match(/^\d{4}$/)) {
    return {
      from: normalizedDate(result.published, "from"),
      to: normalizedDate(result.published, "to"),
    };
  }
  if (result.published?.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const date = normalizedDate(result.published, "from");
    return { from: date, to: date };
  }
  if (result.year === undefined) return undefined;
  return {
    from: `${result.year}-01-01`,
    to: `${result.year}-12-31`,
  };
}

export async function searchWiki(
  query: string,
  options: SearchOptions & ServiceOptions = {},
): Promise<SearchRun> {
  if (!query.trim()) throw new Error("Search query must not be empty");
  const config = await loadConfig(options.root);
  const allowedUpgrades = await upgradeSources(
    config.sourcesDir,
    options.upgradeSourceIds,
  );
  const limit = options.limit ?? config.search.resultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Search limit must be from 1 to 100");
  if (options.fullText && !options.importResults) {
    throw new Error(
      "Full-text acquisition requires importResults and LLM screening",
    );
  }
  const from = options.from ? normalizedDate(options.from, "from") : undefined;
  const to = options.to ? normalizedDate(options.to, "to") : undefined;
  if (from && to && from > to)
    throw new Error("from date must not be after to date");
  const oaOnly = options.oaOnly ?? config.search.oaOnly ?? true;
  const maxDownloads = options.maxDownloads ?? config.search.maxDownloads ?? 3;
  const maxFileBytes =
    options.maxFileBytes ?? config.search.maxFileBytes ?? 100 * 1024 * 1024;
  if (!Number.isInteger(maxDownloads) || maxDownloads < 0)
    throw new Error("maxDownloads must be a non-negative integer");
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1)
    throw new Error("maxFileBytes must be a positive integer");
  const configured = options.providers;
  const providerObjects = options.provider
    ? [options.provider]
    : configured?.length && typeof configured[0] !== "string"
      ? (configured as SearchProvider[])
      : ((configured as string[] | undefined)?.map((name) =>
          searchProviderRegistry.create(
            name as "crossref" | "arxiv" | "openalex",
            options.fetch ?? globalThis.fetch,
          ),
        ) ??
        config.search.providers.map((name) =>
          searchProviderRegistry.create(
            name,
            options.fetch ?? globalThis.fetch,
          ),
        ));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let results: SearchResult[] = [];
  const errors: string[] = [];
  try {
    const settled = await Promise.allSettled(
      providerObjects.map((provider) =>
        provider.search(query, {
          limit: Math.min(limit * 2, 100),
          signal: controller.signal,
        }),
      ),
    );
    results = mergeSearchResults(
      settled.flatMap((result, index) => {
        if (result.status === "fulfilled") return result.value;
        errors.push(
          `${providerObjects[index]!.name}: ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`,
        );
        return [];
      }),
    )
      .filter((result) => {
        const published = resultDateRange(result);
        if (from && (!published || published.to < from)) return false;
        if (to && (!published || published.from > to)) return false;
        return true;
      })
      .slice(0, limit);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
  const imported = [];
  const usage = new LlmUsageTracker(options.maxLlmTokens);
  let downloads = 0;
  let downloadAttempts = 0;
  if (options.importResults) {
    const llm = requireLlm(config, options);
    for (const result of results) {
      const content = evidenceText(result);
      const locationLicense = result.fullTextLocations?.find(
        (location) => location.license,
      )?.license;
      const resolvedLicense = result.license ?? locationLicense;
      const hasOpenFullText = result.fullTextLocations?.some(
        (location) => location.openAccess === true,
      );
      if (!result.abstract && !result.snippet) {
        errors.push(
          `Skipped "${result.title}": search result contained no abstract or snippet evidence`,
        );
        continue;
      }
      const screening = await screenSearchCandidate(
        config,
        llm,
        result,
        { query },
        usage,
      );
      if (!screening.relevant) continue;
      if (
        screening.duplicate &&
        !(options.fullText && matchesUpgradeSource(result, allowedUpgrades))
      ) {
        continue;
      }
      if (options.fullText) {
        if (downloadAttempts >= maxDownloads) {
          errors.push(
            `Skipped "${result.title}": maxDownloads limit (${maxDownloads}) reached`,
          );
          if (options.onFullTextFailure === "skip") continue;
        } else {
          const hasEligibleLocation = result.fullTextLocations?.some(
            (location) =>
              location.kind !== "landing" &&
              (oaOnly
                ? location.openAccess === true
                : location.openAccess === true || Boolean(location.license)),
          );
          if (hasEligibleLocation) downloadAttempts++;
          try {
            const acquired = await acquireFullText(result, {
              root: config.root,
              ...(options.fetch ? { fetch: options.fetch } : {}),
              ...(options.now ? { now: options.now } : {}),
              ...(options.signal ? { signal: options.signal } : {}),
              oaOnly,
              maxFileBytes,
            });
            imported.push(acquired.imported);
            downloads++;
            continue;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            errors.push(`Full text for "${result.title}" failed: ${message}`);
            if (options.onFullTextFailure === "skip") continue;
          }
        }
      }
      imported.push(
        await ingestContent(content, result.url, {
          root: config.root,
          title: result.title,
          mediaType: "application/vnd.llmwiki.search-result+text",
          provenanceKind: "search",
          url: result.url,
          provider: result.provider,
          literature: {
            id: result.id,
            title: result.title,
            url: result.url,
            provider: result.provider,
            ...(result.providers?.length
              ? { providers: result.providers }
              : {}),
            ...(result.doi ? { doi: result.doi } : {}),
            ...(result.arxivId ? { arxivId: result.arxivId } : {}),
            ...(result.openAlexId ? { openAlexId: result.openAlexId } : {}),
            ...(result.sourceId ? { sourceId: result.sourceId } : {}),
            ...(result.versionId ? { versionId: result.versionId } : {}),
            ...(result.authors?.length ? { authors: result.authors } : {}),
            ...(result.published ? { published: result.published } : {}),
            ...(result.year !== undefined ? { year: result.year } : {}),
            ...(result.venue ? { venue: result.venue } : {}),
            ...(resolvedLicense ? { license: resolvedLicense } : {}),
            ...(result.openAccess === true || hasOpenFullText
              ? { openAccess: true }
              : result.openAccess === false
                ? { openAccess: false }
                : {}),
            ...(result.oaStatus ? { oaStatus: result.oaStatus } : {}),
            ...(result.citationCount !== undefined
              ? { citationCount: result.citationCount }
              : {}),
            ...(result.workType ? { workType: result.workType } : {}),
            ...(result.isRetracted !== undefined
              ? { isRetracted: result.isRetracted }
              : {}),
            ...(result.sourceProvenance?.length
              ? { sourceProvenance: result.sourceProvenance }
              : {}),
          },
          ...(options.now ? { now: options.now } : {}),
        }),
      );
    }
  }
  return {
    query,
    provider: providerObjects.map((provider) => provider.name).join(","),
    providers: providerObjects.map((provider) => provider.name),
    results,
    imported,
    errors,
    fullTextDownloads: downloads,
    fullTextAttempts: downloadAttempts,
    usage: usage.result(),
  };
}
import { readFile } from "node:fs/promises";
import path from "node:path";
