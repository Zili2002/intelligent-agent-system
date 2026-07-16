import path from "node:path";
import { adjudicateWiki } from "./adjudicate.js";
import { compileWiki } from "./compile.js";
import { loadConfig } from "./config.js";
import { evaluateRetrieval } from "./evaluate.js";
import {
  completeEvidenceClue,
  getEvidenceFrontierStatus,
  selectEvidenceClues,
} from "./frontier.js";
import { hasUncompiledSources } from "./learn.js";
import { WikiLlmResponseError } from "./llm.js";
import { searchWiki } from "./search.js";
import { buildSemanticIndex } from "./semantic-index.js";
import { getStatus } from "./status.js";
import type {
  EvidenceFrontierRunResult,
  LlmUsage,
  SearchOptions,
  SearchRun,
  ServiceOptions,
} from "./types.js";
import { mapConcurrent, readTextIfExists } from "./utils.js";

function tokenTotal(usage?: LlmUsage): number {
  return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
}

function addUsage(target: Required<LlmUsage>, usage?: LlmUsage): void {
  target.inputTokens += usage?.inputTokens ?? 0;
  target.outputTokens += usage?.outputTokens ?? 0;
}

function remainingTokens(
  maximum: number | undefined,
  used: number,
): number | undefined {
  if (maximum === undefined) return undefined;
  const remaining = maximum - used;
  if (remaining < 1) throw new Error("Evidence Frontier exhausted its budget");
  return remaining;
}

function childOptions(
  options: ServiceOptions,
  root: string,
  maximum?: number,
): ServiceOptions {
  return {
    root,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.approveLlm !== undefined
      ? { approveLlm: options.approveLlm }
      : {}),
    ...(options.llmProvider ? { llmProvider: options.llmProvider } : {}),
    ...(options.embeddingProvider
      ? { embeddingProvider: options.embeddingProvider }
      : {}),
    ...(maximum === undefined ? {} : { maxLlmTokens: maximum }),
  };
}

export async function runEvidenceFrontier(
  options: SearchOptions & ServiceOptions & { clueLimit?: number } = {},
): Promise<EvidenceFrontierRunResult> {
  const config = await loadConfig(options.root);
  const selection = await selectEvidenceClues({
    ...options,
    ...(options.clueLimit ? { limit: options.clueLimit } : {}),
  });
  let searches: SearchRun[] = [];
  const totalUsage: Required<LlmUsage> = {
    inputTokens: 0,
    outputTokens: 0,
  };
  let frontier = selection.status;
  const maximumDownloads =
    options.maxDownloads ?? config.search.maxDownloads ?? 3;
  try {
    const clueCount = selection.clues.length;
    const perClueTokens =
      options.maxLlmTokens === undefined || clueCount === 0
        ? undefined
        : Math.floor(options.maxLlmTokens / clueCount);
    const baseDownloads =
      clueCount === 0 ? 0 : Math.floor(maximumDownloads / clueCount);
    const extraDownloads = clueCount === 0 ? 0 : maximumDownloads % clueCount;
    searches = await mapConcurrent(
      selection.clues,
      config.lifecycle.frontierConcurrency,
      async (clue, index) => {
        let run;
        try {
          run = await searchWiki(clue.query, {
            ...childOptions(options, config.root, perClueTokens),
            importResults: true,
            limit: options.limit ?? config.search.resultLimit,
            fullText: options.fullText ?? false,
            oaOnly: options.oaOnly ?? config.search.oaOnly ?? true,
            maxDownloads: baseDownloads + (index < extraDownloads ? 1 : 0),
            maxFileBytes:
              options.maxFileBytes ??
              config.search.maxFileBytes ??
              100 * 1024 * 1024,
            onFullTextFailure: options.onFullTextFailure ?? "metadata",
            upgradeSourceIds: clue.targetIds
              .filter((target) => target.startsWith("source-"))
              .map((target) => target.slice("source-".length)),
            ...(options.provider ? { provider: options.provider } : {}),
            ...(options.providers ? { providers: options.providers } : {}),
            ...(options.from ? { from: options.from } : {}),
            ...(options.to ? { to: options.to } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
          });
        } catch (error) {
          await completeEvidenceClue(
            clue.id,
            {
              resultCount: 0,
              importedCount: 0,
              error: error instanceof Error ? error.message : String(error),
            },
            options,
          );
          throw error;
        }
        const clueError =
          run.results.length === 0 && run.errors.length
            ? run.errors.join("; ")
            : undefined;
        await completeEvidenceClue(
          clue.id,
          {
            resultCount: run.results.length,
            importedCount: run.imported.length,
            ...(clueError ? { error: clueError } : {}),
          },
          options,
        );
        return run;
      },
    );
    for (const run of searches) addUsage(totalUsage, run.usage);
    frontier = await getEvidenceFrontierStatus(options);
    const imported = searches.reduce(
      (total, search) => total + search.imported.length,
      0,
    );
    const before = await getStatus({ root: config.root });
    const needsCompile = imported > 0 || (await hasUncompiledSources(config));
    const needsAdjudication = before.pendingAdjudications > 0;
    const needsIndex = before.semanticStaleClaims > 0;
    let compiled = false;
    let globalSynthesis = false;
    let indexed = false;
    let evaluated = false;
    if (needsCompile) {
      const compilation = await compileWiki({
        ...childOptions(
          options,
          config.root,
          remainingTokens(options.maxLlmTokens, tokenTotal(totalUsage)),
        ),
        deferGlobalSynthesis: true,
      });
      addUsage(totalUsage, compilation.usage);
      compiled = true;
      globalSynthesis = compilation.globalSynthesis ?? true;
    }
    if ((needsCompile && globalSynthesis) || needsAdjudication) {
      const adjudication = await adjudicateWiki(
        childOptions(
          options,
          config.root,
          remainingTokens(options.maxLlmTokens, tokenTotal(totalUsage)),
        ),
      );
      addUsage(totalUsage, adjudication.usage);
    }
    if (needsCompile || needsIndex) {
      await buildSemanticIndex(childOptions(options, config.root));
      indexed = true;
    }
    if (globalSynthesis || needsAdjudication || (!needsCompile && needsIndex)) {
      if (
        await readTextIfExists(
          path.join(config.metaDir, "retrieval_benchmark.json"),
        )
      ) {
        await evaluateRetrieval({
          ...childOptions(options, config.root),
          answer: false,
        });
        evaluated = true;
      }
    }
    return {
      selected: selection.clues,
      searches,
      imported,
      compiled,
      indexed,
      evaluated,
      frontier,
      usage: totalUsage,
    };
  } catch (error) {
    if (error instanceof WikiLlmResponseError) error.addUsage(totalUsage);
    throw error;
  }
}
