import { readFile } from "node:fs/promises";
import path from "node:path";
import { LlmUsageTracker, requestJson } from "./llm.js";
import type {
  LlmProvider,
  ResolvedWikiConfig,
  SearchResult,
  SourceArtifact,
} from "./types.js";
import { normalizeText, sha256, walkFiles } from "./utils.js";

interface ScreeningVerdict {
  relevant: boolean;
  duplicate: boolean;
  reason: string;
}

async function existingSourceIndex(
  config: ResolvedWikiConfig,
): Promise<unknown[]> {
  const sources: Array<
    Pick<SourceArtifact, "id" | "title" | "content" | "provenance">
  > = [];
  for (const file of await walkFiles(config.sourcesDir, ".json")) {
    const value = JSON.parse(
      await readFile(file, "utf8"),
    ) as Partial<SourceArtifact>;
    if (
      typeof value.id === "string" &&
      typeof value.title === "string" &&
      typeof value.content === "string" &&
      value.provenance
    ) {
      sources.push(
        value as Pick<
          SourceArtifact,
          "id" | "title" | "content" | "provenance"
        >,
      );
    }
  }
  return sources
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((source) => {
      const normalized = normalizeText(source.content);
      return {
        id: source.id,
        title: source.title,
        url: source.provenance.url,
        fingerprint: sha256(normalized),
        summary: normalized.slice(0, 500),
      };
    });
}

export async function screenSearchCandidate(
  config: ResolvedWikiConfig,
  provider: LlmProvider,
  candidate: SearchResult,
  context: { query: string; gap?: string },
  usage?: LlmUsageTracker,
): Promise<ScreeningVerdict> {
  const existing = await existingSourceIndex(config);
  return requestJson(
    provider,
    {
      purpose: "screening",
      maxTokens: config.llm.screeningOutputTokens,
      prompt: `Screen a candidate for the research focus and semantic duplication. Return JSON {relevant:boolean,duplicate:boolean,reason:string}. A duplicate means materially overlapping evidence with an existing source, not merely shared words. Use only the supplied records.
Research focus: ${config.researchFocus}
Search query: ${context.query}
${context.gap ? `Research gap: ${context.gap}\n` : ""}Candidate: ${JSON.stringify(candidate)}
Existing source index: ${JSON.stringify(existing)}`,
    },
    (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("screening must be an object");
      const result = value as Record<string, unknown>;
      if (
        typeof result.relevant !== "boolean" ||
        typeof result.duplicate !== "boolean" ||
        typeof result.reason !== "string" ||
        !result.reason.trim()
      )
        throw new Error("invalid screening response");
      return {
        relevant: result.relevant,
        duplicate: result.duplicate,
        reason: result.reason.trim(),
      };
    },
    usage,
  );
}
