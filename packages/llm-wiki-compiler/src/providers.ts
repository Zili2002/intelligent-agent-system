import { XMLParser } from "fast-xml-parser";
import type {
  FullTextLocation,
  OpenAlexLookupProvider,
  SearchProvider,
  SearchResult,
} from "./types.js";

type Fetcher = typeof globalThis.fetch;
type Sleeper = (milliseconds: number) => Promise<void>;

const sleep: Sleeper = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function values<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function dateYear(value: string | undefined): number | undefined {
  const match = value?.match(/^(\d{4})/);
  return match ? Number(match[1]) : undefined;
}

function arxivBaseId(value: string): string {
  return value
    .replace(/^arxiv:/i, "")
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/\.pdf$/i, "")
    .replace(/v\d+$/i, "")
    .trim();
}

let nextArxivRequestAt = 0;
let arxivQueue: Promise<void> = Promise.resolve();

/** Resets the module-wide arXiv throttle for deterministic tests only. */
export function resetArxivThrottleForTests(): void {
  nextArxivRequestAt = 0;
  arxivQueue = Promise.resolve();
}

export interface ArxivProviderOptions {
  fetch?: Fetcher;
  now?: () => number;
  sleep?: Sleeper;
}

/**
 * Official arXiv Atom API client. The API requests are globally serialized at
 * a three-second interval, including when separate instances are used.
 */
export class ArxivProvider implements SearchProvider {
  readonly name = "arxiv";
  readonly #fetch: Fetcher;
  readonly #now: () => number;
  readonly #sleep: Sleeper;

  constructor(options: ArxivProviderOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (!this.#fetch) throw new Error("arXiv search requires fetch");
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? sleep;
  }

  async search(
    query: string,
    options: { limit: number; signal?: AbortSignal },
  ): Promise<SearchResult[]> {
    const release = await this.#reserveRequest(options.signal);

    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("search_query", `all:${query}`);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(Math.min(options.limit, 100)));
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { accept: "application/atom+xml" },
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } finally {
      release();
    }
    if (!response.ok)
      throw new Error(`arXiv search failed: HTTP ${response.status}`);

    const parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
      trimValues: true,
      parseTagValue: false,
    }).parse(await response.text()) as {
      feed?: { entry?: unknown };
    };
    return values(parsed.feed?.entry)
      .map((raw): SearchResult | undefined => {
        const entry = raw as Record<string, unknown>;
        const id = text(entry.id);
        const title = text(entry.title)?.replace(/\s+/g, " ");
        if (!id || !title) return undefined;
        const idWithVersion = id
          .replace(/^https?:\/\/arxiv\.org\/abs\//i, "")
          .trim();
        const links = values<Record<string, unknown>>(
          entry.link as Record<string, unknown> | undefined,
        );
        const locations = links.reduce<FullTextLocation[]>(
          (locations, link) => {
            const href = text(link["@_href"]);
            if (!href) return locations;
            const type = text(link["@_type"]);
            const titleAttr = text(link["@_title"]);
            if (type === "application/pdf" || titleAttr === "pdf") {
              locations.push({
                url: href,
                kind: "pdf" as const,
                openAccess: true,
                source: this.name,
                priority: "arxiv",
              });
            }
            if (type === "text/html" && /\/html\//i.test(href)) {
              locations.push({
                url: href,
                kind: "html" as const,
                openAccess: true,
                source: this.name,
                priority: "arxiv",
              });
            } else if (
              type === "text/html" ||
              /\/abs\//i.test(href) ||
              text(link["@_rel"]) === "alternate"
            ) {
              locations.push({
                url: href,
                kind: "landing" as const,
                openAccess: true,
                source: this.name,
              });
            }
            return locations;
          },
          [],
        );
        const published = text(entry.published);
        const summary = text(entry.summary)?.replace(/\s+/g, " ");
        const doi = text(entry.doi);
        const license = text(entry.license);
        const categories = values<Record<string, unknown>>(
          entry.category as Record<string, unknown> | undefined,
        )
          .map((category) => text(category["@_term"]))
          .filter((category): category is string => !!category);
        return {
          id: idWithVersion,
          title,
          url: id,
          provider: this.name,
          arxivId: arxivBaseId(idWithVersion),
          versionId: idWithVersion,
          ...(doi ? { doi } : {}),
          ...(license ? { license, openAccess: true } : {}),
          ...(summary
            ? { abstract: summary, snippet: summary.slice(0, 500) }
            : {}),
          ...(published
            ? {
                published,
                ...(dateYear(published) !== undefined
                  ? { year: dateYear(published)! }
                  : {}),
              }
            : {}),
          ...(categories.length ? { venue: categories.join(", ") } : {}),
          authors: values<Record<string, unknown>>(
            entry.author as Record<string, unknown> | undefined,
          )
            .map((author) => text(author.name))
            .filter((author): author is string => !!author),
          fullTextLocations: [
            ...locations,
            ...(!locations.some(
              (location) => location.kind === "landing" && location.url === id,
            )
              ? [
                  {
                    url: id,
                    kind: "landing" as const,
                    openAccess: true,
                    ...(license ? { license } : {}),
                    source: this.name,
                  },
                ]
              : []),
          ],
          sourceProvenance: [
            { provider: this.name, id: idWithVersion, url: id },
          ],
        };
      })
      .filter((result): result is SearchResult => !!result)
      .slice(0, options.limit);
  }

  async #reserveRequest(signal?: AbortSignal): Promise<() => void> {
    const previous = arxivQueue;
    let release!: () => void;
    arxivQueue = new Promise((resolve) => {
      release = resolve;
    });
    let reserved = false;
    try {
      await waitForAbort(previous, signal);
      const remaining = nextArxivRequestAt - this.#now();
      if (remaining > 0) await sleepWithAbort(this.#sleep(remaining), signal);
      if (signal?.aborted) throw new Error("arXiv search was aborted");
      nextArxivRequestAt = this.#now() + 3_000;
      reserved = true;
      return release;
    } finally {
      if (!reserved) release();
    }
  }
}

function waitForAbort<T>(value: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return value;
  if (signal.aborted)
    return Promise.reject(new Error("arXiv search was aborted"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("arXiv search was aborted"));
    signal.addEventListener("abort", abort, { once: true });
    value.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function sleepWithAbort(
  value: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  return waitForAbort(value, signal);
}

export interface OpenAlexDiagnostics {
  rateLimitRemaining?: number;
  rateLimitLimit?: number;
  creditsRemaining?: number;
}

export interface OpenAlexProviderOptions {
  fetch?: Fetcher;
  sleep?: Sleeper;
  apiKey?: string;
  mailto?: string;
}

/** OpenAlex works search client; its diagnostics deliberately never include credentials. */
export class OpenAlexProvider implements OpenAlexLookupProvider {
  readonly name = "openalex";
  readonly #fetch: Fetcher;
  readonly #sleep: Sleeper;
  readonly #apiKey: string | undefined;
  readonly #mailto: string | undefined;
  lastDiagnostics: OpenAlexDiagnostics = {};

  constructor(options: OpenAlexProviderOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (!this.#fetch) throw new Error("OpenAlex search requires fetch");
    this.#sleep = options.sleep ?? sleep;
    this.#apiKey = options.apiKey ?? process.env.OPENALEX_API_KEY;
    this.#mailto = options.mailto ?? process.env.OPENALEX_MAILTO;
  }

  async search(
    query: string,
    options: { limit: number; signal?: AbortSignal },
  ): Promise<SearchResult[]> {
    this.requireApiKey();
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", query);
    url.searchParams.set("per-page", String(Math.min(options.limit, 100)));
    this.#addCredentials(url);

    const data = (await this.#request(url, options.signal, "search")) as {
      results?: unknown[];
    };
    return (data.results ?? [])
      .map((work) => this.#mapWork(work))
      .filter((result): result is SearchResult => !!result)
      .slice(0, options.limit);
  }

  /** Fails without exposing the configured key value. */
  requireApiKey(): void {
    if (!this.#apiKey)
      throw new Error(
        "OpenAlex search requires OPENALEX_API_KEY (or an injected apiKey)",
      );
  }

  async lookupByOpenAlexId(
    value: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SearchResult | undefined> {
    this.requireApiKey();
    const id = value
      .trim()
      .replace(/^https?:\/\/openalex\.org\//i, "")
      .toUpperCase();
    if (!/^W\d+$/i.test(id)) return undefined;
    const url = new URL(`https://api.openalex.org/works/${id}`);
    this.#addCredentials(url);
    try {
      return this.#mapWork(await this.#request(url, options.signal, "lookup"));
    } catch (error) {
      if (error instanceof OpenAlexHttpError && error.status === 404)
        return undefined;
      throw error;
    }
  }

  async lookupByDoi(
    value: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SearchResult | undefined> {
    this.requireApiKey();
    const doi = value
      .trim()
      .replace(/^doi:\s*/i, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .toLowerCase();
    if (!doi) return undefined;
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("filter", `doi:${doi}`);
    url.searchParams.set("per-page", "2");
    this.#addCredentials(url);
    const data = (await this.#request(url, options.signal, "lookup")) as {
      results?: unknown[];
    };
    return (data.results ?? [])
      .map((work) => this.#mapWork(work))
      .find((result) => result?.doi?.toLowerCase() === doi);
  }

  async #request(
    url: URL,
    signal: AbortSignal | undefined,
    operation: "search" | "lookup",
  ): Promise<unknown> {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await this.#fetch(url, {
        headers: { accept: "application/json" },
        ...(signal ? { signal } : {}),
      });
      this.#recordDiagnostics(response.headers);
      if (response.ok || (response.status !== 429 && response.status < 500))
        break;
      if (attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const wait =
          Number.isFinite(retryAfter) && retryAfter >= 0
            ? Math.min(retryAfter * 1_000, 5_000)
            : 250 * 2 ** attempt;
        await this.#sleep(wait);
      }
    }
    if (!response?.ok)
      throw new OpenAlexHttpError(
        response?.status ?? 0,
        `OpenAlex ${operation} failed: HTTP ${response?.status ?? "unknown"}`,
      );
    return response.json();
  }

  #addCredentials(url: URL): void {
    if (this.#apiKey) url.searchParams.set("api_key", this.#apiKey);
    if (this.#mailto) url.searchParams.set("mailto", this.#mailto);
  }

  #recordDiagnostics(headers: Headers): void {
    const numberHeader = (...names: string[]) => {
      for (const name of names) {
        const value = Number(headers.get(name));
        if (Number.isFinite(value)) return value;
      }
      return undefined;
    };
    const remaining = numberHeader(
      "x-ratelimit-remaining",
      "ratelimit-remaining",
    );
    const limit = numberHeader("x-ratelimit-limit", "ratelimit-limit");
    const credits = numberHeader("x-credits-remaining", "credits-remaining");
    this.lastDiagnostics = {
      ...(remaining !== undefined ? { rateLimitRemaining: remaining } : {}),
      ...(limit !== undefined ? { rateLimitLimit: limit } : {}),
      ...(credits !== undefined ? { creditsRemaining: credits } : {}),
    };
  }

  #mapWork(raw: unknown): SearchResult | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const work = raw as Record<string, unknown>;
    const title = text(work.title);
    const id = text(work.id);
    if (!title || !id) return undefined;
    const abstractIndex = work.abstract_inverted_index;
    const abstract =
      abstractIndex && typeof abstractIndex === "object"
        ? Object.entries(abstractIndex as Record<string, unknown>)
            .flatMap(([word, positions]) =>
              values(positions as number[]).map(
                (position) => [position, word] as const,
              ),
            )
            .filter(([position]) => Number.isInteger(position))
            .sort(([left], [right]) => left - right)
            .map(([, word]) => word)
            .join(" ")
        : undefined;
    const doi = text(work.doi)?.replace(/^https?:\/\/doi\.org\//i, "");
    const openAccess =
      work.open_access && typeof work.open_access === "object"
        ? (work.open_access as Record<string, unknown>)
        : {};
    const oaStatus = text(openAccess.oa_status);
    const inheritedOpenAccess = openAccess.is_oa === true;
    const locations = [
      ...this.#locations(
        work.best_oa_location,
        inheritedOpenAccess,
        "openalex-best",
      ),
      ...values<unknown>(work.locations).flatMap((location) =>
        this.#locations(location, false, "openalex"),
      ),
    ].filter(
      (location, index, all) =>
        all.findIndex((candidate) => candidate.url === location.url) === index,
    );
    const arxivId = locations
      .map(
        (location) =>
          location.url.match(
            /^https?:\/\/arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?(?:[?#]|$)/i,
          )?.[1],
      )
      .find((value): value is string => Boolean(value));
    const authors = values<Record<string, unknown>>(
      work.authorships as Record<string, unknown> | undefined,
    )
      .map((authorship) => {
        const author = authorship.author;
        return author && typeof author === "object"
          ? text((author as Record<string, unknown>).display_name)
          : undefined;
      })
      .filter((author): author is string => !!author);
    const publication = text(work.publication_date);
    const primaryLocation =
      work.primary_location && typeof work.primary_location === "object"
        ? (work.primary_location as Record<string, unknown>)
        : {};
    const source =
      primaryLocation.source && typeof primaryLocation.source === "object"
        ? (primaryLocation.source as Record<string, unknown>)
        : {};
    const venue = text(source.display_name);
    const workType = text(work.type);
    const license = locations.find((location) => location.license)?.license;
    return {
      id,
      title,
      url: text(work.doi) ?? id,
      provider: this.name,
      openAlexId: id,
      ...(text(source.id) ? { sourceId: text(source.id)! } : {}),
      ...(doi ? { doi } : {}),
      ...(arxivId ? { arxivId: arxivBaseId(arxivId) } : {}),
      ...(abstract ? { abstract, snippet: abstract.slice(0, 500) } : {}),
      ...(publication
        ? {
            published: publication,
            ...(dateYear(publication) !== undefined
              ? { year: dateYear(publication)! }
              : {}),
          }
        : {}),
      ...(venue ? { venue } : {}),
      ...(authors.length ? { authors } : {}),
      ...(typeof work.cited_by_count === "number"
        ? { citationCount: work.cited_by_count }
        : {}),
      ...(workType ? { workType } : {}),
      ...(typeof work.is_retracted === "boolean"
        ? { isRetracted: work.is_retracted }
        : {}),
      ...(typeof openAccess.is_oa === "boolean"
        ? { openAccess: openAccess.is_oa }
        : {}),
      ...(oaStatus ? { oaStatus } : {}),
      ...(license ? { license } : {}),
      fullTextLocations: locations,
      sourceProvenance: [
        { provider: this.name, id, url: text(work.doi) ?? id },
      ],
    };
  }

  #locations(
    raw: unknown,
    inheritedOpenAccess: boolean,
    priority: "openalex-best" | "openalex",
  ): FullTextLocation[] {
    if (!raw || typeof raw !== "object") return [];
    const location = raw as Record<string, unknown>;
    const license = text(location.license);
    const isOa = location.is_oa === true || inheritedOpenAccess;
    const values = [
      [text(location.pdf_url), "pdf"],
      [text(location.content_url), "html"],
      [text(location.landing_page_url), "landing"],
    ] as const;
    return values
      .filter(([url]) => !!url)
      .map(([url, kind]) => ({
        url: url!,
        kind,
        openAccess: isOa,
        ...(license ? { license } : {}),
        source: this.name,
        priority,
      }));
  }
}

class OpenAlexHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
