import {
  findEvidenceAnchor,
  normalizeArxivId,
  normalizeDoi,
  searchWiki,
  type SearchProvider,
  type SearchProviderName,
  type SourceArtifact,
} from "@intelligent-agent-system/llm-wiki-compiler";
import type { CitationAuditItem, EvidenceAnchor } from "../types.js";

export interface CitationAuditOptions {
  root: string;
  approveNetwork?: boolean;
  providers?: SearchProviderName[] | SearchProvider[];
  fetch?: typeof globalThis.fetch;
}

export async function auditSourceCitations(
  source: SourceArtifact,
  options: CitationAuditOptions,
): Promise<CitationAuditItem[]> {
  const references = extractReferences(source);
  if (!references.length) return [];
  if (options.approveNetwork !== true) {
    throw new Error(
      "Citation audit requires explicit network approval (approveNetwork: true)",
    );
  }
  const audits: CitationAuditItem[] = [];
  for (const reference of references) {
    const run = await searchWiki(reference.value, {
      root: options.root,
      limit: 5,
      importResults: false,
      ...(options.providers ? { providers: options.providers } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const exact = run.results.filter((result) =>
      reference.kind === "doi"
        ? normalizeDoi(result.doi ?? result.id) === reference.value
        : normalizeArxivId(result.arxivId ?? result.id) === reference.value,
    );
    const providers = [
      ...new Set(
        exact.flatMap((result) => [
          result.provider,
          ...(result.providers ?? []),
        ]),
      ),
    ];
    const configuredCount =
      options.providers?.length ?? run.providers?.length ?? 1;
    const status: CitationAuditItem["status"] = exact.some(
      (result) => result.isRetracted === true,
    )
      ? "retracted"
      : exact.length
        ? "verified"
        : run.errors.length
          ? "unresolvable"
          : configuredCount >= 2
            ? "suspicious"
            : "unresolvable";
    audits.push({
      kind: reference.kind,
      value: reference.value,
      status,
      providers,
      evidence: toReaderAnchor(findEvidenceAnchor(source, reference.quote)),
    });
  }
  return audits;
}

function extractReferences(
  source: SourceArtifact,
): Array<{ kind: "doi" | "arxiv"; value: string; quote: string }> {
  const references: Array<{
    kind: "doi" | "arxiv";
    value: string;
    quote: string;
  }> = [];
  for (const match of source.content.matchAll(
    /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/gi,
  )) {
    const value = normalizeDoi(match[0]);
    if (value) references.push({ kind: "doi", value, quote: match[0] });
  }
  for (const match of source.content.matchAll(
    /\barXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)\b/gi,
  )) {
    const value = normalizeArxivId(match[1]);
    if (value) references.push({ kind: "arxiv", value, quote: match[0] });
  }
  return references.filter(
    (reference, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.kind === reference.kind &&
          candidate.value === reference.value,
      ) === index,
  );
}

function toReaderAnchor(anchor: {
  sourceId: string;
  quote: string;
  start: number;
  end: number;
  page?: number;
  section?: string;
}): EvidenceAnchor {
  return { ...anchor };
}
