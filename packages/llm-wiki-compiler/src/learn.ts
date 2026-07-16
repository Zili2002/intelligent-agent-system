import { readFile } from "node:fs/promises";
import path from "node:path";
import { compileWiki } from "./compile.js";
import { loadConfig } from "./config.js";
import {
  admitEvidenceClues,
  completeEvidenceClue,
  inferEvidenceTopic,
  selectEvidenceClues,
} from "./frontier.js";
import { WikiLlmResponseError } from "./llm.js";
import { searchWiki } from "./search.js";
import type { LearnResult, SearchOptions, ServiceOptions } from "./types.js";
import { readTextIfExists, sha256, walkFiles, writeText } from "./utils.js";

interface Gap {
  priority: number;
  description: string;
  searchQuery: string;
}

function tokenTotal(usage?: { inputTokens?: number; outputTokens?: number }) {
  return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
}

function remainingTokens(
  maximum: number | undefined,
  used: number,
): number | undefined {
  if (maximum === undefined) return undefined;
  const remaining = maximum - used;
  if (remaining < 1) {
    throw new Error("Wiki learning exhausted its LLM token budget");
  }
  return remaining;
}

function serviceOptions(
  options: ServiceOptions,
  root: string,
  maxLlmTokens?: number,
): ServiceOptions {
  const result: ServiceOptions = { root };
  if (options.fetch !== undefined) result.fetch = options.fetch;
  if (options.now !== undefined) result.now = options.now;
  if (options.approveLlm !== undefined) result.approveLlm = options.approveLlm;
  if (options.llmProvider !== undefined)
    result.llmProvider = options.llmProvider;
  if (maxLlmTokens !== undefined) result.maxLlmTokens = maxLlmTokens;
  return result;
}

export async function hasUncompiledSources(
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<boolean> {
  const graphContent = await readTextIfExists(
    path.join(config.metaDir, "knowledge_graph.json"),
  );
  const graph = graphContent
    ? (JSON.parse(graphContent) as { sources?: Array<{ id?: unknown }> })
    : {};
  const compiled = new Set(
    Array.isArray(graph.sources)
      ? graph.sources
          .map((source) =>
            typeof source.id === "string" ? source.id : undefined,
          )
          .filter((id): id is string => Boolean(id))
      : [],
  );
  for (const file of await walkFiles(config.sourcesDir, ".json")) {
    const source = JSON.parse(await readFile(file, "utf8")) as { id?: unknown };
    if (typeof source.id !== "string") {
      throw new Error(`Malformed source artifact: ${file}`);
    }
    if (!compiled.has(source.id)) return true;
  }
  return false;
}

export async function learnWiki(
  options: SearchOptions & ServiceOptions & { gapLimit?: number } = {},
): Promise<LearnResult> {
  const { maxLlmTokens } = options;
  const config = await loadConfig(options.root);
  const data = JSON.parse(
    await readFile(path.join(config.metaDir, "gaps.json"), "utf8").catch(() => {
      throw new Error(
        "No structured LLM gaps found. Run compile or reflect first.",
      );
    }),
  ) as { gaps?: Gap[] };
  if (!Array.isArray(data.gaps))
    throw new Error("Malformed structured gaps artifact");
  const gapLimit = options.gapLimit ?? 3;
  if (!Number.isInteger(gapLimit) || gapLimit < 1)
    throw new Error("Gap limit must be a positive integer");
  const gapCandidates = [...data.gaps]
    .sort((a, b) => a.priority - b.priority)
    .slice(0, gapLimit);
  const admission = await admitEvidenceClues(
    gapCandidates.map((gap) => ({
      query: gap.searchQuery,
      targetId: `gap-${sha256(gap.description).slice(0, 24)}`,
      problemId: `gap-${sha256(gap.description).slice(0, 24)}`,
      topicId: inferEvidenceTopic(gap.searchQuery, "gap"),
      kind: "gap",
      priority: Math.max(0, 100 - gap.priority * 10),
    })),
    options,
  );
  const frontierSelection = await selectEvidenceClues({
    ...options,
    limit: gapLimit,
    ids: [...new Set(admission.clues.map((clue) => clue.id))],
  });
  const selected = frontierSelection.clues;
  const searches = [];
  const successfulUsage = { inputTokens: 0, outputTokens: 0 };
  let usedTokens = 0;
  const totalDownloadLimit =
    options.maxDownloads ?? config.search.maxDownloads ?? 3;
  let downloadsUsed = 0;
  let frontierStatus = frontierSelection.status;
  for (const clue of selected) {
    let run;
    try {
      const runOptions: SearchOptions & ServiceOptions = {
        ...serviceOptions(
          options,
          config.root,
          maxLlmTokens === undefined
            ? undefined
            : remainingTokens(maxLlmTokens, usedTokens),
        ),
        root: config.root,
        importResults: true,
      };
      if (options.provider !== undefined)
        runOptions.provider = options.provider;
      if (options.providers !== undefined)
        runOptions.providers = options.providers;
      if (options.limit !== undefined) runOptions.limit = options.limit;
      if (options.from !== undefined) runOptions.from = options.from;
      if (options.to !== undefined) runOptions.to = options.to;
      if (options.fullText !== undefined)
        runOptions.fullText = options.fullText;
      if (options.onFullTextFailure !== undefined)
        runOptions.onFullTextFailure = options.onFullTextFailure;
      if (options.oaOnly !== undefined) runOptions.oaOnly = options.oaOnly;
      if (options.maxFileBytes !== undefined)
        runOptions.maxFileBytes = options.maxFileBytes;
      if (options.signal !== undefined) runOptions.signal = options.signal;
      if (options.fullText) {
        runOptions.maxDownloads = Math.max(
          0,
          totalDownloadLimit - downloadsUsed,
        );
      } else if (options.maxDownloads !== undefined) {
        runOptions.maxDownloads = options.maxDownloads;
      }
      run = await searchWiki(clue.query, runOptions);
    } catch (error) {
      frontierStatus = await completeEvidenceClue(
        clue.id,
        {
          resultCount: 0,
          importedCount: 0,
          error: error instanceof Error ? error.message : String(error),
        },
        options,
      );
      if (error instanceof WikiLlmResponseError) {
        error.addUsage(successfulUsage);
      }
      throw error;
    }
    usedTokens += tokenTotal(run.usage);
    successfulUsage.inputTokens += run.usage?.inputTokens ?? 0;
    successfulUsage.outputTokens += run.usage?.outputTokens ?? 0;
    downloadsUsed += run.fullTextAttempts ?? 0;
    searches.push(run);
    frontierStatus = await completeEvidenceClue(
      clue.id,
      {
        resultCount: run.results.length,
        importedCount: run.imported.length,
        ...(run.results.length === 0 && run.errors.length
          ? { error: run.errors.join("; ") }
          : {}),
      },
      options,
    );
  }
  const imported = searches.reduce((sum, run) => sum + run.imported.length, 0);
  const needsCompile = imported > 0 || (await hasUncompiledSources(config));
  let compilation;
  try {
    compilation = needsCompile
      ? await compileWiki(
          serviceOptions(
            options,
            config.root,
            maxLlmTokens === undefined
              ? undefined
              : remainingTokens(maxLlmTokens, usedTokens),
          ),
        )
      : undefined;
  } catch (error) {
    if (error instanceof WikiLlmResponseError) {
      error.addUsage(successfulUsage);
    }
    throw error;
  }
  usedTokens += tokenTotal(compilation?.usage);
  const now = (options.now ?? (() => new Date()))().toISOString();
  const logPath = path.join(config.metaDir, "learning-log.md");
  const log = (await readTextIfExists(logPath)) ?? "# Learning log\n";
  await writeText(
    logPath,
    `${log.trimEnd()}\n\n- ${now}: frontier_selected=${selected.length}, imported=${imported}, recompiled=${Boolean(compilation)}`,
  );
  const evolutionPath = path.join(config.metaDir, "evolution_log.md");
  const evolution =
    (await readTextIfExists(evolutionPath)) ?? "# Evolution log\n";
  await writeText(
    evolutionPath,
    `${evolution.trimEnd()}\n\n- ${now}: learning selected=${selected.length}, frontier=true, imported=${imported}, recompiled=${Boolean(compilation)}`,
  );
  return {
    selectedGaps: selected.map((clue) => clue.query),
    searches,
    imported,
    compiled: Boolean(compilation),
    logPath,
    frontier: frontierStatus,
    usage: {
      inputTokens:
        searches.reduce(
          (total, run) => total + (run.usage?.inputTokens ?? 0),
          0,
        ) + (compilation?.usage?.inputTokens ?? 0),
      outputTokens:
        searches.reduce(
          (total, run) => total + (run.usage?.outputTokens ?? 0),
          0,
        ) + (compilation?.usage?.outputTokens ?? 0),
    },
  };
}
