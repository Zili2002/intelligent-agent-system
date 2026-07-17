import type { SourceArtifact } from "./types.js";
import { findEvidenceAnchor, type SourceEvidenceAnchor } from "./evidence.js";

export interface SourceSection {
  id: string;
  title: string;
  start: number;
  end: number;
  content: string;
  page?: number;
}

export interface SourceQueryMatch {
  score: number;
  excerpt: string;
  anchor: SourceEvidenceAnchor;
}

const HEADING_ALIASES: Array<[RegExp, string]> = [
  [/^abstract$/i, "abstract"],
  [/^(?:\d+(?:\.\d+)*)?\s*introduction$/i, "introduction"],
  [/^(?:\d+(?:\.\d+)*)?\s*related work$/i, "related-work"],
  [
    /^(?:\d+(?:\.\d+)*)?\s*(?:method|methods|methodology|approach)$/i,
    "methods",
  ],
  [/^(?:\d+(?:\.\d+)*)?\s*(?:theory|theoretical analysis)$/i, "theory"],
  [
    /^(?:\d+(?:\.\d+)*)?\s*(?:experiment|experiments|evaluation|results)$/i,
    "experiments",
  ],
  [/^(?:\d+(?:\.\d+)*)?\s*(?:ablation|ablation study)$/i, "ablation"],
  [/^(?:\d+(?:\.\d+)*)?\s*(?:limitations?|discussion)$/i, "limitations"],
  [/^(?:\d+(?:\.\d+)*)?\s*(?:references|bibliography)$/i, "references"],
];

export function extractSourceSections(source: SourceArtifact): SourceSection[] {
  const headings = findHeadings(source.content);
  if (!headings.length) {
    return [
      {
        id: "full-text",
        title: "Full text",
        start: 0,
        end: source.content.length,
        content: source.content,
        ...(pageAt(source, 0) === undefined
          ? {}
          : { page: pageAt(source, 0)! }),
      },
    ];
  }
  return headings.map((heading, index) => {
    const end = headings[index + 1]?.start ?? source.content.length;
    const page = pageAt(source, heading.start);
    return {
      id: heading.id,
      title: heading.title,
      start: heading.start,
      end,
      content: source.content.slice(heading.contentStart, end).trim(),
      ...(page === undefined ? {} : { page }),
    };
  });
}

export function querySource(
  source: SourceArtifact,
  question: string,
  limit = 5,
): SourceQueryMatch[] {
  if (!question.trim()) throw new Error("Source query must not be empty");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Source query limit must be from 1 to 50");
  }
  const queryTokens = tokens(question);
  return source.content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length >= 20)
    .map((paragraph) => {
      const paragraphTokens = tokens(paragraph);
      let matches = 0;
      for (const token of queryTokens) {
        if (paragraphTokens.has(token)) matches += 1;
      }
      return {
        paragraph,
        score: queryTokens.size ? matches / queryTokens.size : 0,
      };
    })
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.paragraph.length - right.paragraph.length,
    )
    .slice(0, limit)
    .map(({ paragraph, score }) => ({
      score,
      excerpt: paragraph,
      anchor: findEvidenceAnchor(source, paragraph),
    }));
}

function findHeadings(
  content: string,
): Array<{ id: string; title: string; start: number; contentStart: number }> {
  const matches: Array<{
    id: string;
    title: string;
    start: number;
    contentStart: number;
  }> = [];
  for (const match of content.matchAll(/^(?:#{1,6}\s+)?([^\n]{2,100})\s*$/gm)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const alias = HEADING_ALIASES.find(([pattern]) => pattern.test(raw));
    const markdown = match[0].startsWith("#");
    if (!alias && !markdown) continue;
    matches.push({
      id: alias?.[1] ?? slug(raw),
      title: raw,
      start: match.index ?? 0,
      contentStart: (match.index ?? 0) + match[0].length,
    });
  }
  return matches.filter(
    (heading, index, all) =>
      all.findIndex((candidate) => candidate.start === heading.start) === index,
  );
}

function pageAt(source: SourceArtifact, offset: number): number | undefined {
  return source.pageLocators?.find(
    (locator) => offset >= locator.start && offset < locator.end,
  )?.page;
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{Letter}\p{Number}]+/gu)
      ?.filter((token) => token.length > 1) ?? [],
  );
}

function slug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLocaleLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "section"
  );
}
