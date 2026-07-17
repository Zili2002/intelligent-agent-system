import {
  findEvidenceAnchor,
  type SourceArtifact,
} from "@intelligent-agent-system/llm-wiki-compiler";
import type { EvidenceAnchor, ReviewIntegrityIssue } from "../types.js";

export function evaluateSourceIntegrity(
  source: SourceArtifact,
): ReviewIntegrityIssue[] {
  const issues: ReviewIntegrityIssue[] = [];
  if (source.literature?.isRetracted === true) {
    issues.push({
      type: "retraction",
      severity: "blocking",
      message: "A provider explicitly marks this work as retracted.",
      evidence: [],
    });
  }
  issues.push(...temporalIssues(source));
  issues.push(...citationIdentifierIssues(source));
  return issues;
}

function temporalIssues(source: SourceArtifact): ReviewIntegrityIssue[] {
  const publicationYear =
    source.literature?.year ??
    Number(source.literature?.published?.slice(0, 4));
  if (!Number.isInteger(publicationYear)) return [];
  const issues: ReviewIntegrityIssue[] = [];
  for (const match of source.content.matchAll(
    /\(([A-Z][\p{Letter}'-]+(?:\s+et\s+al\.)?),\s*((?:19|20)\d{2})[a-z]?\)/gu,
  )) {
    const citedYear = Number(match[2]);
    if (citedYear <= publicationYear) continue;
    issues.push({
      type: "temporal",
      severity: "high-warning",
      message: `Citation-like reference ${match[1]} (${citedYear}) is later than the work's publication year ${publicationYear}.`,
      evidence: [anchor(source, match[0])],
    });
  }
  return issues;
}

function citationIdentifierIssues(
  source: SourceArtifact,
): ReviewIntegrityIssue[] {
  const identifiers = [
    ...source.content.matchAll(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/gi),
    ...source.content.matchAll(/\barXiv:\s*\d{4}\.\d{4,5}(?:v\d+)?\b/gi),
  ];
  if (!identifiers.length) return [];
  return [
    {
      type: "citation",
      severity: "advisory",
      message: `${identifiers.length} DOI/arXiv identifier occurrence(s) are available for optional multi-provider verification.`,
      evidence: identifiers
        .slice(0, 5)
        .map((match) => anchor(source, match[0])),
    },
  ];
}

function anchor(source: SourceArtifact, quote: string): EvidenceAnchor {
  return findEvidenceAnchor(source, quote);
}
