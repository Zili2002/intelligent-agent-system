import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { OpenAlexProvider } from "./providers.js";
import type {
  LiteratureMetadata,
  OpenAlexEnrichmentItem,
  OpenAlexEnrichmentOptions,
  OpenAlexEnrichmentResult,
  SearchResult,
  SourceArtifact,
} from "./types.js";
import { walkFiles, writeText } from "./utils.js";

function normalizeDoi(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .toLowerCase();
  return normalized || undefined;
}

function normalizeOpenAlexId(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/^https?:\/\/openalex\.org\//i, "")
    .toUpperCase();
  return normalized || undefined;
}

function normalizeArxivId(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/^arxiv:\s*/i, "")
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/\.pdf$/i, "")
    .replace(/v\d+$/i, "");
  return normalized || undefined;
}

function normalizeSearchTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface LegacyMetadata {
  title?: string;
  doi?: string;
  arxivId?: string;
  authors?: string[];
  published?: string;
  year?: number;
  url?: string;
}

function line(content: string, label: string): string | undefined {
  return content
    .match(new RegExp(`^${label}:\\s*(.+?)\\s*$`, "im"))?.[1]
    ?.trim();
}

/** Extracts only explicit legacy search fields; it makes no quality inference. */
export function extractLegacyLiterature(
  artifact: SourceArtifact,
): LegacyMetadata {
  const content = artifact.content ?? "";
  const doi = normalizeDoi(
    line(content, "DOI") ??
      content.match(
        /\b(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,9}\/[-._;()/:a-z0-9]+)\b/i,
      )?.[1],
  );
  const authorLine = line(content, "Authors?") ?? line(content, "Author");
  const published = line(content, "Published");
  const yearValue = line(content, "Year") ?? published?.match(/^\d{4}/)?.[0];
  const year =
    yearValue && /^\d{4}$/.test(yearValue) ? Number(yearValue) : undefined;
  const url =
    line(content, "URL") ??
    artifact.provenance.url ??
    (/^https?:\/\//i.test(artifact.provenance.input)
      ? artifact.provenance.input
      : undefined);
  const arxivId = normalizeArxivId(
    artifact.literature?.arxivId ??
      url?.match(
        /^https?:\/\/arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?(?:[?#]|$)/i,
      )?.[1],
  );
  const heading = content.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
  return {
    ...(heading || artifact.title ? { title: heading ?? artifact.title } : {}),
    ...(doi ? { doi } : {}),
    ...(arxivId ? { arxivId } : {}),
    ...(authorLine
      ? {
          authors: authorLine
            .split(/\s*;\s*|\s+\band\b\s+|\s*,\s*(?=[A-Z])/i)
            .map((author) => author.trim())
            .filter(Boolean),
        }
      : {}),
    ...(published ? { published } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(url ? { url } : {}),
  };
}

function surname(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = normalizeSearchTitle(value);
  if (!normalized) return undefined;
  const comma = value.indexOf(",");
  if (comma >= 0) return normalizeSearchTitle(value.slice(0, comma));
  return normalized.split(" ").at(-1);
}

function unique<T>(values: T[], key: (value: T) => string): T[] {
  return values.filter(
    (value, index, all) =>
      all.findIndex((item) => key(item) === key(value)) === index,
  );
}

function mergedAuthors(
  first: string[] | undefined,
  second: string[] | undefined,
): string[] | undefined {
  const value = unique(
    [...(first ?? []), ...(second ?? [])].filter(Boolean),
    (item) => normalizeSearchTitle(item),
  );
  return value.length ? value : undefined;
}

function mergeMetadata(
  existing: LiteratureMetadata | undefined,
  legacy: LegacyMetadata,
  result: SearchResult,
): { metadata: LiteratureMetadata; conflicts: string[] } {
  const incomingDoi = normalizeDoi(result.doi);
  const incomingOpenAlexId = normalizeOpenAlexId(result.openAlexId);
  const incoming: LiteratureMetadata = {
    id: result.id,
    title: result.title,
    url: result.url,
    provider: result.provider,
    ...(result.providers?.length ? { providers: result.providers } : {}),
    ...(incomingDoi ? { doi: incomingDoi } : {}),
    ...(result.arxivId ? { arxivId: result.arxivId } : {}),
    ...(incomingOpenAlexId ? { openAlexId: incomingOpenAlexId } : {}),
    ...(result.sourceId ? { sourceId: result.sourceId } : {}),
    ...(result.versionId ? { versionId: result.versionId } : {}),
    ...(result.authors?.length ? { authors: result.authors } : {}),
    ...(result.published ? { published: result.published } : {}),
    ...(result.year !== undefined ? { year: result.year } : {}),
    ...(result.venue ? { venue: result.venue } : {}),
    ...(result.license ? { license: result.license } : {}),
    ...(result.openAccess !== undefined
      ? { openAccess: result.openAccess }
      : {}),
    ...(result.oaStatus ? { oaStatus: result.oaStatus } : {}),
    ...(result.citationCount !== undefined
      ? { citationCount: result.citationCount }
      : {}),
    ...(result.workType ? { workType: result.workType } : {}),
    ...(result.isRetracted !== undefined
      ? { isRetracted: result.isRetracted }
      : {}),
    sourceProvenance: result.sourceProvenance ?? [
      { provider: result.provider, id: result.id, url: result.url },
    ],
  };
  const base: LiteratureMetadata = existing ?? {
    id: incoming.id,
    title: legacy.title ?? incoming.title,
    url: legacy.url ?? incoming.url,
    provider: incoming.provider,
  };
  const conflicts: string[] = [];
  const identifiers: Array<
    [
      keyof Pick<LiteratureMetadata, "doi" | "arxivId" | "openAlexId">,
      (value: string) => string | undefined,
    ]
  > = [
    ["doi", normalizeDoi],
    ["arxivId", (value) => value.trim().replace(/v\d+$/i, "") || undefined],
    ["openAlexId", normalizeOpenAlexId],
  ];
  for (const [field, normalize] of identifiers) {
    const before = base[field];
    const after = incoming[field];
    if (before && after && normalize(before) !== normalize(after))
      conflicts.push(`${field} conflict preserved`);
  }
  const provenance = unique(
    [...(base.sourceProvenance ?? []), ...(incoming.sourceProvenance ?? [])],
    (item) => `${item.provider}|${item.id ?? ""}|${item.url ?? ""}`,
  );
  const providers = unique(
    [
      base.provider,
      ...(base.providers ?? []),
      incoming.provider,
      ...(incoming.providers ?? []),
    ].filter(Boolean),
    (item) => item,
  );
  const selectIdentifier = (
    field: "doi" | "arxivId" | "openAlexId",
  ): string | undefined => base[field] ?? incoming[field];
  const doi = selectIdentifier("doi");
  const arxivId = selectIdentifier("arxivId");
  const openAlexId = selectIdentifier("openAlexId");
  const authors = mergedAuthors(
    base.authors ?? legacy.authors,
    incoming.authors,
  );
  return {
    metadata: {
      ...base,
      id: base.id || incoming.id,
      title: base.title || legacy.title || incoming.title,
      url: base.url || legacy.url || incoming.url,
      provider: base.provider || incoming.provider,
      providers,
      ...(doi ? { doi } : {}),
      ...(arxivId ? { arxivId } : {}),
      ...(openAlexId ? { openAlexId } : {}),
      ...((base.sourceId ?? incoming.sourceId)
        ? { sourceId: base.sourceId ?? incoming.sourceId }
        : {}),
      ...((base.versionId ?? incoming.versionId)
        ? { versionId: base.versionId ?? incoming.versionId }
        : {}),
      ...(authors ? { authors } : {}),
      ...((base.published ?? legacy.published ?? incoming.published)
        ? {
            published: base.published ?? legacy.published ?? incoming.published,
          }
        : {}),
      ...((base.year ?? legacy.year ?? incoming.year)
        ? { year: base.year ?? legacy.year ?? incoming.year }
        : {}),
      ...((base.venue ?? incoming.venue)
        ? { venue: base.venue ?? incoming.venue }
        : {}),
      ...((base.license ?? incoming.license)
        ? { license: base.license ?? incoming.license }
        : {}),
      ...(base.openAccess === true || incoming.openAccess === true
        ? { openAccess: true }
        : base.openAccess === false || incoming.openAccess === false
          ? { openAccess: false }
          : {}),
      ...((base.oaStatus ?? incoming.oaStatus)
        ? { oaStatus: base.oaStatus ?? incoming.oaStatus }
        : {}),
      ...(Math.max(base.citationCount ?? 0, incoming.citationCount ?? 0) > 0
        ? {
            citationCount: Math.max(
              base.citationCount ?? 0,
              incoming.citationCount ?? 0,
            ),
          }
        : {}),
      ...((base.workType ?? incoming.workType)
        ? { workType: base.workType ?? incoming.workType }
        : {}),
      ...(base.isRetracted === true || incoming.isRetracted === true
        ? { isRetracted: true }
        : base.isRetracted === false || incoming.isRetracted === false
          ? { isRetracted: false }
          : {}),
      ...(provenance.length ? { sourceProvenance: provenance } : {}),
    },
    conflicts,
  };
}

function isAlreadyEnriched(metadata: LiteratureMetadata | undefined): boolean {
  return Boolean(
    metadata?.openAlexId &&
      metadata.citationCount !== undefined &&
      metadata.workType &&
      metadata.isRetracted !== undefined,
  );
}

function titleCandidates(
  results: SearchResult[],
  title: string,
  year: number | undefined,
  author: string | undefined,
): { valid: SearchResult[]; exactCount: number } {
  const normalizedTitle = normalizeSearchTitle(title);
  const exact = results.filter(
    (result) => normalizeSearchTitle(result.title) === normalizedTitle,
  );
  return {
    exactCount: exact.length,
    valid: unique(
      exact.filter((result) => {
        const candidateYear =
          result.year ?? Number(result.published?.slice(0, 4));
        if (year !== undefined && candidateYear !== year) return false;
        const candidateAuthor = surname(result.authors?.[0]);
        return !author || !candidateAuthor || author === candidateAuthor;
      }),
      (result) => normalizeOpenAlexId(result.openAlexId) ?? result.id,
    ),
  };
}

export async function enrichOpenAlex(
  options: OpenAlexEnrichmentOptions = {},
): Promise<OpenAlexEnrichmentResult> {
  const config = await loadConfig(options.root);
  const files = await walkFiles(config.sourcesDir, ".json");
  const limit = options.limit ?? files.length;
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("OpenAlex enrichment limit must be a positive integer");
  const provider =
    options.openAlexProvider ??
    new OpenAlexProvider(options.fetch ? { fetch: options.fetch } : {});
  if (provider instanceof OpenAlexProvider) provider.requireApiKey();
  const result: OpenAlexEnrichmentResult = {
    scanned: 0,
    matchedByOpenAlexId: 0,
    matchedByDoi: 0,
    matchedByArxivId: 0,
    matchedByTitle: 0,
    enriched: 0,
    unchanged: 0,
    ambiguous: 0,
    failed: 0,
    errors: [],
    items: [],
  };
  for (const file of files.slice(0, limit)) {
    const artifact = JSON.parse(await readFile(file, "utf8")) as SourceArtifact;
    result.scanned++;
    if (options.onlyMissing && isAlreadyEnriched(artifact.literature)) {
      result.items.push({
        path: file,
        sourceId: artifact.id,
        status: "skipped",
      });
      continue;
    }
    const legacy = extractLegacyLiterature(artifact);
    const metadata = artifact.literature;
    let match: SearchResult | undefined;
    let matchedBy: "openalexId" | "doi" | "arxivId" | "title" | undefined;
    try {
      const openAlexId = normalizeOpenAlexId(metadata?.openAlexId);
      const doi = normalizeDoi(metadata?.doi ?? legacy.doi);
      const arxivId = normalizeArxivId(metadata?.arxivId ?? legacy.arxivId);
      if (openAlexId) {
        match = await provider.lookupByOpenAlexId(
          openAlexId,
          options.signal ? { signal: options.signal } : {},
        );
        if (match && normalizeOpenAlexId(match.openAlexId) === openAlexId)
          matchedBy = "openalexId";
      }
      if (!match && doi) {
        match = await provider.lookupByDoi(
          doi,
          options.signal ? { signal: options.signal } : {},
        );
        if (match && normalizeDoi(match.doi) === doi) matchedBy = "doi";
      }
      const title = metadata?.title || legacy.title || artifact.title;
      let searched: SearchResult[] | undefined;
      if (!match && arxivId) {
        searched = await provider.search(
          title,
          options.signal
            ? { limit: 10, signal: options.signal }
            : { limit: 10 },
        );
        const exactArxiv = searched.filter(
          (candidate) => normalizeArxivId(candidate.arxivId) === arxivId,
        );
        if (exactArxiv.length === 1) {
          match = exactArxiv[0];
          matchedBy = "arxivId";
        } else if (exactArxiv.length > 1) {
          result.ambiguous++;
          result.items.push({
            path: file,
            sourceId: artifact.id,
            status: "ambiguous",
            message: "Multiple OpenAlex records matched the exact arXiv ID",
          });
          continue;
        }
      }
      if (!match) {
        const year = metadata?.year ?? legacy.year;
        const author = surname(metadata?.authors?.[0] ?? legacy.authors?.[0]);
        const candidates = titleCandidates(
          searched ??
            (await provider.search(
              title,
              options.signal
                ? { limit: 10, signal: options.signal }
                : { limit: 10 },
            )),
          title,
          year,
          author,
        );
        if (candidates.valid.length === 1) {
          match = candidates.valid[0];
          matchedBy = "title";
        } else if (candidates.exactCount > 0) {
          result.ambiguous++;
          result.items.push({
            path: file,
            sourceId: artifact.id,
            status: "ambiguous",
            message: "OpenAlex title candidates were ambiguous or incompatible",
          });
          continue;
        }
      }
      if (!match || !matchedBy) {
        result.unchanged++;
        result.items.push({
          path: file,
          sourceId: artifact.id,
          status: "unchanged",
        });
        continue;
      }
      const merged = mergeMetadata(metadata, legacy, match);
      const changed =
        JSON.stringify(metadata) !== JSON.stringify(merged.metadata);
      if (matchedBy === "openalexId") result.matchedByOpenAlexId++;
      if (matchedBy === "doi") result.matchedByDoi++;
      if (matchedBy === "arxivId") result.matchedByArxivId++;
      if (matchedBy === "title") result.matchedByTitle++;
      if (changed) {
        if (!options.dryRun) {
          await writeText(
            file,
            JSON.stringify(
              { ...artifact, literature: merged.metadata },
              null,
              2,
            ),
          );
        }
        result.enriched++;
        result.items.push({
          path: file,
          sourceId: artifact.id,
          status: "enriched",
          match: matchedBy,
          ...(merged.conflicts.length ? { conflicts: merged.conflicts } : {}),
        });
      } else {
        result.unchanged++;
        result.items.push({
          path: file,
          sourceId: artifact.id,
          status: "unchanged",
          match: matchedBy,
          ...(merged.conflicts.length ? { conflicts: merged.conflicts } : {}),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failed++;
      result.errors.push({ path: file, sourceId: artifact.id, message });
      result.items.push({
        path: file,
        sourceId: artifact.id,
        status: "failed",
        message,
      });
    }
  }
  return result;
}
