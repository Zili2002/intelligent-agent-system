import {
  extractSourceSections,
  type SourceArtifact,
} from "@intelligent-agent-system/llm-wiki-compiler";
import type { PaperReview, ReviewLevel } from "../types.js";

export interface ReviewMaterial {
  text: string;
  coverage: PaperReview["coverage"];
}

const STANDARD_ORDER = [
  "abstract",
  "introduction",
  "related-work",
  "methods",
  "theory",
  "experiments",
  "ablation",
  "limitations",
  "references",
  "full-text",
];

export function buildReviewMaterial(
  source: SourceArtifact,
  level: Exclude<ReviewLevel, "fast">,
): ReviewMaterial {
  const sections = extractSourceSections(source);
  const ordered =
    level === "standard"
      ? [...sections].sort(
          (left, right) =>
            rank(left.id) - rank(right.id) || left.start - right.start,
        )
      : sections;
  const maximumCharacters = level === "standard" ? 60_000 : 120_000;
  const selected: typeof sections = [];
  let used = 0;
  for (const section of ordered) {
    if (used >= maximumCharacters) break;
    const remaining = maximumCharacters - used;
    const content = section.content.slice(0, remaining);
    if (!content.trim()) continue;
    selected.push({ ...section, content });
    used += content.length;
  }
  if (!selected.length) {
    throw new Error(`Source ${source.id} contains no reviewable text`);
  }
  const pages = [
    ...new Set(
      selected
        .map((section) => section.page)
        .filter((page): page is number => page !== undefined),
    ),
  ].sort((left, right) => left - right);
  return {
    text: selected
      .map((section) => `## ${section.title}\n\n${section.content}`)
      .join("\n\n"),
    coverage: {
      fullText: true,
      sections: selected.map((section) => section.id),
      pages,
      coverageScore: Math.min(1, used / Math.max(1, source.content.length)),
    },
  };
}

function rank(sectionId: string): number {
  const index = STANDARD_ORDER.indexOf(sectionId);
  return index < 0 ? STANDARD_ORDER.length : index;
}
