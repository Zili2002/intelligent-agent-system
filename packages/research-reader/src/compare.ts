import path from "node:path";
import { atomicWriteJson, atomicWriteText } from "@intelligent-agent/shared";
import {
  LlmUsageTracker,
  findEvidenceAnchor,
  generatedDocument,
  getSourceArtifact,
  loadConfig,
  requestJson,
  requireLlm,
  sha256,
  slugify,
  type LlmProvider,
  type SourceArtifact,
} from "@intelligent-agent-system/llm-wiki-compiler";
import type {
  EvidenceAnchor,
  PaperComparison,
  PaperPassport,
  ReaderQuestionOptions,
  ResolvedReaderConfig,
} from "./types.js";

interface RawComparison {
  summary: string;
  differences: Array<{
    topic: string;
    analysis: string;
    evidence: Array<{ paperId: string; quote: string }>;
  }>;
}

export async function comparePapers(
  config: ResolvedReaderConfig,
  papers: PaperPassport[],
  options: ReaderQuestionOptions = {},
  now = new Date(),
): Promise<PaperComparison> {
  if (papers.length < 2 || papers.length > 8) {
    throw new Error("Paper comparison requires from 2 to 8 papers");
  }
  const uniqueIds = new Set(papers.map((paper) => paper.id));
  if (uniqueIds.size !== papers.length) {
    throw new Error("Paper comparison requires unique Paper IDs");
  }
  const sources = new Map<string, SourceArtifact>();
  for (const paper of papers) {
    const sourceId = paper.acquisition.fullTextSourceId;
    if (!sourceId) {
      throw new Error(`Paper ${paper.id} has no acquired full text`);
    }
    const source = await getSourceArtifact(sourceId, { root: config.root });
    if (!source) throw new Error(`Full-text source not found: ${sourceId}`);
    sources.set(paper.id, source);
  }
  const provider = await resolveComparisonLlm(config, options);
  const usage = new LlmUsageTracker(options.maxLlmTokens);
  const raw = await requestJson(
    provider,
    {
      purpose: "synthesis",
      maxTokens: 5_000,
      prompt: `Compare the supplied papers without treating unmatched experimental settings as directly comparable. Return JSON {summary:string,differences:[{topic:string,analysis:string,evidence:[{paperId:string,quote:string}]}]}. Every evidence quote must be copied verbatim from the corresponding supplied source.
${papers
  .map((paper) => {
    const source = sources.get(paper.id)!;
    return `Paper ${paper.id}: ${paper.metadata.title}\n${source.content.slice(0, 60_000)}`;
  })
  .join("\n\n")}`,
    },
    parseComparison,
    usage,
  );
  const differences = raw.differences.map((difference) => ({
    topic: difference.topic,
    analysis: difference.analysis,
    evidence: difference.evidence.map(({ paperId, quote }) => {
      const source = sources.get(paperId);
      if (!source) {
        throw new Error(`Comparison cited unknown Paper ID: ${paperId}`);
      }
      return toReaderAnchor(findEvidenceAnchor(source, quote));
    }),
  }));
  const createdAt = now.toISOString();
  const id = `comparison-${sha256(
    `${[...uniqueIds].sort().join("|")}:${createdAt}`,
  ).slice(0, 24)}`;
  const baseName = `${slugify(papers.map((paper) => paper.metadata.title).join("-vs-")).slice(0, 70)}-${id.slice(-8)}`;
  const markdownPath = path.join(
    config.wikiDir,
    "comparisons",
    `${baseName}.md`,
  );
  const jsonPath = path.join(config.metaDir, "comparisons", `${id}.json`);
  const comparison: PaperComparison = {
    version: 1,
    id,
    paperIds: papers.map((paper) => paper.id),
    summary: raw.summary,
    differences,
    model: provider.name,
    usage: usage.result(),
    createdAt,
    markdownPath,
    jsonPath,
  };
  await Promise.all([
    atomicWriteJson(jsonPath, comparison),
    atomicWriteText(
      markdownPath,
      generatedDocument(
        {
          title: papers.map((paper) => paper.metadata.title).join(" vs "),
          generated: "true",
          type: "paper-comparison",
          paper_ids: papers.map((paper) => paper.id),
        },
        renderComparison(comparison, papers),
      ),
    ),
  ]);
  return comparison;
}

function renderComparison(
  comparison: PaperComparison,
  papers: PaperPassport[],
): string {
  const titles = new Map(
    papers.map((paper) => [paper.id, paper.metadata.title]),
  );
  return `# Paper comparison

## Papers

${comparison.paperIds.map((id) => `- \`${id}\`: ${titles.get(id)}`).join("\n")}

## Summary

${comparison.summary}

## Differences

${comparison.differences
  .map(
    (difference) => `### ${difference.topic}

${difference.analysis}

${difference.evidence
  .map(
    (anchor) =>
      `- Evidence: “${anchor.quote}” (source \`${anchor.sourceId}\`${anchor.page === undefined ? "" : `, p. ${anchor.page}`}${anchor.section ? `, ${anchor.section}` : ""})`,
  )
  .join("\n")}`,
  )
  .join("\n\n")}`;
}

async function resolveComparisonLlm(
  config: ResolvedReaderConfig,
  options: ReaderQuestionOptions,
): Promise<LlmProvider> {
  if (options.llmProvider) return options.llmProvider;
  const wikiConfig = await loadConfig(config.root);
  return requireLlm(wikiConfig, {
    root: config.root,
    ...(options.approveLlm === true ? { approveLlm: true } : {}),
    ...(options.maxLlmTokens === undefined
      ? {}
      : { maxLlmTokens: options.maxLlmTokens }),
  });
}

function parseComparison(value: unknown): RawComparison {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Paper comparison must be an object");
  }
  const data = value as Record<string, unknown>;
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    throw new Error("Paper comparison requires a summary");
  }
  if (!Array.isArray(data.differences)) {
    throw new Error("Paper comparison differences must be an array");
  }
  return {
    summary: data.summary.trim(),
    differences: data.differences.map((item, index) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(
          `Paper comparison difference ${index} must be an object`,
        );
      }
      const difference = item as Record<string, unknown>;
      if (
        typeof difference.topic !== "string" ||
        !difference.topic.trim() ||
        typeof difference.analysis !== "string" ||
        !difference.analysis.trim() ||
        !Array.isArray(difference.evidence)
      ) {
        throw new Error(`Paper comparison difference ${index} is invalid`);
      }
      return {
        topic: difference.topic.trim(),
        analysis: difference.analysis.trim(),
        evidence: difference.evidence.map((entry, evidenceIndex) => {
          if (
            typeof entry !== "object" ||
            entry === null ||
            Array.isArray(entry)
          ) {
            throw new Error(
              `Paper comparison evidence ${index}.${evidenceIndex} must be an object`,
            );
          }
          const evidence = entry as Record<string, unknown>;
          if (
            typeof evidence.paperId !== "string" ||
            !evidence.paperId ||
            typeof evidence.quote !== "string" ||
            !evidence.quote
          ) {
            throw new Error(
              `Paper comparison evidence ${index}.${evidenceIndex} is invalid`,
            );
          }
          return { paperId: evidence.paperId, quote: evidence.quote };
        }),
      };
    }),
  };
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
