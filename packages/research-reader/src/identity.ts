import {
  normalizeArxivId,
  normalizeDoi,
  normalizeOpenAlexId,
  normalizeSearchTitle,
  sha256,
  type LiteratureMetadata,
  type SearchResult,
} from "@intelligent-agent-system/llm-wiki-compiler";

export function canonicalLiteratureKey(
  value: SearchResult | LiteratureMetadata,
): string {
  const doi = normalizeDoi(value.doi);
  if (doi) return `doi:${doi}`;
  const arxivId = normalizeArxivId(value.arxivId);
  if (arxivId) return `arxiv:${arxivId}`;
  const openAlexId = normalizeOpenAlexId(value.openAlexId);
  if (openAlexId) return `openalex:${openAlexId}`;
  const title = normalizeSearchTitle(value.title);
  const year = value.year ?? Number(value.published?.slice(0, 4));
  const firstAuthor = normalizeSearchTitle(value.authors?.[0] ?? "");
  if (title && Number.isInteger(year) && firstAuthor) {
    return `work:${title}:${year}:${firstAuthor}`;
  }
  if (value.id?.trim() || value.url?.trim()) {
    return `record:${value.provider}:${sha256(
      `${value.id?.trim() ?? ""}:${value.url?.trim() ?? ""}`,
    )}`;
  }
  throw new Error(
    `Cannot establish canonical identity for literature record: ${value.title}`,
  );
}

export function paperIdFromCanonicalKey(canonicalKey: string): string {
  if (!canonicalKey.trim()) throw new Error("Canonical key must not be empty");
  return `paper-${sha256(canonicalKey).slice(0, 24)}`;
}

export function searchResultToMetadata(
  result: SearchResult,
): LiteratureMetadata {
  const doi = normalizeDoi(result.doi);
  const arxivId = normalizeArxivId(result.arxivId);
  const openAlexId = normalizeOpenAlexId(result.openAlexId);
  return {
    id: result.id,
    title: result.title,
    url: result.url,
    provider: result.provider,
    ...(result.providers?.length
      ? { providers: [...new Set(result.providers)] }
      : {}),
    ...(doi ? { doi } : {}),
    ...(arxivId ? { arxivId } : {}),
    ...(openAlexId ? { openAlexId } : {}),
    ...(result.sourceId ? { sourceId: result.sourceId } : {}),
    ...(result.versionId ? { versionId: result.versionId } : {}),
    ...(result.authors?.length ? { authors: [...result.authors] } : {}),
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
    ...(result.sourceProvenance?.length
      ? { sourceProvenance: structuredClone(result.sourceProvenance) }
      : {}),
  };
}

export function mergeLiteratureMetadata(
  existing: LiteratureMetadata,
  incoming: LiteratureMetadata,
): LiteratureMetadata {
  const providers = [
    ...new Set([
      existing.provider,
      ...(existing.providers ?? []),
      incoming.provider,
      ...(incoming.providers ?? []),
    ]),
  ];
  const sourceProvenance = [
    ...(existing.sourceProvenance ?? []),
    ...(incoming.sourceProvenance ?? []),
  ].filter(
    (entry, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.provider === entry.provider &&
          candidate.id === entry.id &&
          candidate.url === entry.url,
      ) === index,
  );
  const citationCount =
    existing.citationCount === undefined && incoming.citationCount === undefined
      ? undefined
      : Math.max(existing.citationCount ?? 0, incoming.citationCount ?? 0);
  const isRetracted =
    existing.isRetracted === true || incoming.isRetracted === true
      ? true
      : (existing.isRetracted ?? incoming.isRetracted);
  return {
    ...existing,
    ...definedEntries(incoming),
    providers,
    ...(sourceProvenance.length ? { sourceProvenance } : {}),
    ...(citationCount === undefined ? {} : { citationCount }),
    ...(isRetracted === undefined ? {} : { isRetracted }),
  };
}

function definedEntries<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}
