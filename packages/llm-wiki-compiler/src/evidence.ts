import { resolveExactQuote } from "./compile.js";
import type { SourceArtifact } from "./types.js";

export interface SourceEvidenceAnchor {
  sourceId: string;
  quote: string;
  start: number;
  end: number;
  page?: number;
  section?: string;
}

export function findEvidenceAnchor(
  source: SourceArtifact,
  requestedQuote: string,
  preferredStart?: number,
): SourceEvidenceAnchor {
  if (!requestedQuote.trim())
    throw new Error("Evidence quote must not be empty");
  if (preferredStart !== undefined) {
    if (
      !Number.isInteger(preferredStart) ||
      preferredStart < 0 ||
      preferredStart + requestedQuote.length > source.content.length ||
      source.content.slice(
        preferredStart,
        preferredStart + requestedQuote.length,
      ) !== requestedQuote
    ) {
      throw new Error("Evidence start offset does not match the source");
    }
    return anchorAt(source, requestedQuote, preferredStart);
  }
  const resolved = resolveExactQuote(source.content, requestedQuote);
  if (!resolved) {
    throw new Error(`Evidence quote is not present in source ${source.id}`);
  }
  if (
    source.content.indexOf(
      resolved.quote,
      resolved.offset + resolved.quote.length,
    ) >= 0
  ) {
    throw new Error(
      "Evidence quote is ambiguous; supply an exact start offset",
    );
  }
  return anchorAt(source, resolved.quote, resolved.offset);
}

function anchorAt(
  source: SourceArtifact,
  quote: string,
  start: number,
): SourceEvidenceAnchor {
  const end = start + quote.length;
  const page = pageAt(source, start);
  const section = sectionAt(source.content, start);
  return {
    sourceId: source.id,
    quote,
    start,
    end,
    ...(page === undefined ? {} : { page }),
    ...(section ? { section } : {}),
  };
}

export function validateEvidenceAnchor(
  source: SourceArtifact,
  anchor: {
    sourceId: string;
    quote: string;
    start?: number;
    end?: number;
    page?: number;
    section?: string;
  },
): SourceEvidenceAnchor {
  if (anchor.sourceId !== source.id) {
    throw new Error(
      `Evidence source mismatch: expected ${source.id}, received ${anchor.sourceId}`,
    );
  }
  const resolved = findEvidenceAnchor(source, anchor.quote, anchor.start);
  if (anchor.end !== undefined && anchor.end !== resolved.end) {
    throw new Error("Evidence end offset does not match the source");
  }
  if (anchor.page !== undefined && anchor.page !== resolved.page) {
    throw new Error("Evidence page does not match the source locator");
  }
  if (anchor.section !== undefined && anchor.section !== resolved.section) {
    throw new Error("Evidence section does not match the source heading");
  }
  return resolved;
}

function pageAt(source: SourceArtifact, offset: number): number | undefined {
  return source.pageLocators?.find(
    (locator) => offset >= locator.start && offset < locator.end,
  )?.page;
}

function sectionAt(content: string, offset: number): string | undefined {
  const headings = [
    ...content.slice(0, offset + 1).matchAll(/^#{1,6}\s+(.+?)\s*$/gm),
  ];
  return headings.at(-1)?.[1]?.trim();
}
