import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, atomicWriteText } from "@intelligent-agent/shared";
import { sha256, slugify } from "@intelligent-agent-system/llm-wiki-compiler";
import { listPaperPassports } from "./store.js";
import type { ResolvedReaderConfig, SurveyPlan } from "./types.js";

interface ClaimsArtifact {
  claims: Array<{
    id: string;
    sourceId: string;
    text: string;
    quote: string;
    topicIds?: string[];
  }>;
  topics?: Array<{
    id: string;
    title: string;
    claimIds: string[];
  }>;
}

export async function createSurveyPlan(
  config: ResolvedReaderConfig,
  question: string,
  now = new Date(),
): Promise<SurveyPlan> {
  if (!question.trim()) throw new Error("Survey question must not be empty");
  const [papers, claimsArtifact, gaps] = await Promise.all([
    listPaperPassports(config),
    readOptionalJson<ClaimsArtifact>(
      path.join(config.root, "meta", "claims.json"),
    ),
    readGaps(path.join(config.root, "meta", "gaps.json")),
  ]);
  const queryTokens = tokens(question);
  const claims = (claimsArtifact?.claims ?? [])
    .map((claim) => ({
      claim,
      score: overlap(tokens(claim.text), queryTokens),
    }))
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.claim.id.localeCompare(right.claim.id),
    )
    .slice(0, 100)
    .map((item) => item.claim);
  const sourceToPaper = new Map<string, string>();
  for (const paper of papers) {
    for (const sourceId of paper.sourceIds)
      sourceToPaper.set(sourceId, paper.id);
  }
  const paperIds = [
    ...new Set(
      claims
        .map((claim) => sourceToPaper.get(claim.sourceId))
        .filter((value): value is string => value !== undefined),
    ),
  ];
  if (!paperIds.length) {
    paperIds.push(
      ...papers
        .filter(
          (paper) => overlap(tokens(paper.metadata.title), queryTokens) > 0,
        )
        .map((paper) => paper.id),
    );
  }
  const claimIds = claims.map((claim) => claim.id);
  const topicIds = [
    ...new Set(
      (claimsArtifact?.topics ?? [])
        .filter((topic) =>
          topic.claimIds.some((claimId) => claimIds.includes(claimId)),
        )
        .map((topic) => topic.id),
    ),
  ];
  const relatedGaps = gaps.filter(
    (gap) => overlap(tokens(gap), queryTokens) > 0,
  );
  const generatedAt = now.toISOString();
  const id = `survey-${sha256(`${question}:${generatedAt}`).slice(0, 24)}`;
  const baseName = `${slugify(question).slice(0, 70)}-${id.slice(-8)}`;
  const markdownPath = path.join(config.surveyReportsDir, `${baseName}.md`);
  const jsonPath = path.join(config.surveyReportsDir, `${baseName}.json`);
  const plan: SurveyPlan = {
    version: 1,
    id,
    question: question.trim(),
    generatedAt,
    paperIds,
    topicIds,
    claimIds,
    gaps: relatedGaps,
    markdownPath,
    jsonPath,
  };
  const paperById = new Map(papers.map((paper) => [paper.id, paper]));
  await Promise.all([
    atomicWriteJson(jsonPath, plan),
    atomicWriteText(
      markdownPath,
      `# Survey plan: ${question.trim()}

## Scope

- Included papers: ${paperIds.length}
- Evidence Claims: ${claimIds.length}
- Topics: ${topicIds.length}

## Evidence matrix

${
  claims
    .map(
      (claim) =>
        `- \`${claim.id}\` — ${claim.text}\n  - Paper: ${paperById.get(sourceToPaper.get(claim.sourceId) ?? "")?.metadata.title ?? "unmapped source"}\n  - Evidence: “${claim.quote}”`,
    )
    .join("\n") || "_No matching compiled Claims._"
}

## Suggested outline

${topicIds.map((topicId, index) => `${index + 1}. ${topicId}`).join("\n") || "1. Define the research question and evidence boundaries."}

## Evidence gaps

${relatedGaps.map((gap) => `- ${gap}`).join("\n") || "_No matching compiled gaps._"}
`,
    ),
  ]);
  return plan;
}

async function readGaps(filePath: string): Promise<string[]> {
  const value = await readOptionalJson<unknown>(filePath);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("gaps" in value) ||
    !Array.isArray(value.gaps)
  ) {
    return [];
  }
  return value.gaps.flatMap((gap) => {
    if (typeof gap === "string") return [gap];
    if (
      typeof gap === "object" &&
      gap !== null &&
      "description" in gap &&
      typeof gap.description === "string"
    ) {
      return [gap.description];
    }
    return [];
  });
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{Letter}\p{Number}]+/gu)
      ?.filter((token) => token.length > 2) ?? [],
  );
}

function overlap(first: Set<string>, second: Set<string>): number {
  if (!second.size) return 0;
  let matches = 0;
  for (const token of second) if (first.has(token)) matches += 1;
  return matches / second.size;
}
