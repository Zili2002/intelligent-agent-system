import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import type {
  QueryMatch,
  QueryResult,
  ServiceOptions,
  SourceArtifact,
} from "./types.js";
import {
  extractiveSummary,
  relativePosix,
  STOP_WORDS,
  tokenize,
  walkFiles,
} from "./utils.js";

interface Candidate {
  path: string;
  title: string;
  content: string;
}

function scoreCandidate(questionTokens: Set<string>, content: string): number {
  const tokens = tokenize(content);
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  let score = 0;
  for (const token of questionTokens)
    score += Math.min(counts.get(token) ?? 0, 5);
  return score;
}

function cleanContent(content: string): string {
  return content
    .replace(/^---[\s\S]*?\n---\s*/m, "")
    .replace(/<!--\s*llmwiki:generated:(?:start|end)\s*-->/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[\[([^|\]]+)\|([^\]]+)]]/g, "$2")
    .replace(/\[\[([^\]]+)]]/g, "$1")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[`*_>]/g, " ");
}

function relevantExcerpt(questionTokens: Set<string>, content: string): string {
  const cleaned = cleanContent(content);
  const sentences = cleaned
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 20);
  const ranked = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      score: scoreCandidate(questionTokens, sentence),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.sentence)
    .join(" ");

  return ranked ? ranked.slice(0, 360) : extractiveSummary(cleaned, 2, 360);
}

export async function queryWiki(
  question: string,
  options: ServiceOptions & { limit?: number } = {},
): Promise<QueryResult> {
  if (!question.trim()) throw new Error("Question must not be empty");
  const limit = options.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Query limit must be an integer from 1 to 100");
  }
  const config = await loadConfig(options.root);
  const candidates: Candidate[] = [];
  for (const file of await walkFiles(config.sourcesDir, ".json")) {
    const artifact = JSON.parse(await readFile(file, "utf8")) as SourceArtifact;
    candidates.push({
      path: relativePosix(config.root, file),
      title: artifact.title,
      content: artifact.content,
    });
  }
  for (const file of await walkFiles(config.wikiDir, ".md")) {
    const content = await readFile(file, "utf8");
    const title =
      content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.basename(file, ".md");
    candidates.push({ path: relativePosix(config.root, file), title, content });
  }
  const questionTokens = new Set(
    tokenize(question).filter(
      (token) => token.length > 2 && !STOP_WORDS.has(token),
    ),
  );
  const matches: QueryMatch[] = candidates
    .map((candidate) => ({
      path: candidate.path,
      title: candidate.title,
      score: scoreCandidate(questionTokens, candidate.content),
      excerpt: relevantExcerpt(questionTokens, candidate.content),
    }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
  if (!matches.length || questionTokens.size === 0) {
    return {
      question,
      answer:
        "No evidence was found in the processed sources or wiki. No answer was generated.",
      matches: [],
    };
  }
  return {
    question,
    answer: matches
      .map((match) => `${match.excerpt} [${match.path}]`)
      .join("\n\n"),
    matches,
  };
}
