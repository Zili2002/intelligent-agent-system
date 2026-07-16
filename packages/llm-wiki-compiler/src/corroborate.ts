import path from "node:path";
import { adjudicateWiki } from "./adjudicate.js";
import { compileWiki } from "./compile.js";
import { loadConfig } from "./config.js";
import {
  admitEvidenceClues,
  completeEvidenceClue,
  inferEvidenceTopic,
  selectEvidenceClues,
} from "./frontier.js";
import {
  cleanModel,
  LlmUsageTracker,
  requestJson,
  requireLlm,
  WikiLlmResponseError,
} from "./llm.js";
import { searchWiki } from "./search.js";
import type {
  CorroborationOptions,
  CorroborationResult,
  CorroborationTarget,
  EvidenceStatus,
  LlmUsage,
  SearchOptions,
  ServiceOptions,
} from "./types.js";
import { readTextIfExists, sha256, writeText } from "./utils.js";

const CORROBORATION_VERSION = 1;

interface ClaimRecord {
  id: string;
  sourceId: string;
  statement: string;
  quote: string;
  topicIds: string[];
}

interface ConfidenceRecord {
  claimId: string;
  confidence: number;
  evidenceStatus: EvidenceStatus;
  independentSupportSources: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string, maximum = 8_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

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
  if (remaining < 1) {
    throw new Error("Wiki corroboration exhausted its LLM token budget");
  }
  return remaining;
}

function childOptions(
  options: ServiceOptions,
  root: string,
  maxLlmTokens?: number,
): ServiceOptions {
  return {
    root,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.approveLlm !== undefined
      ? { approveLlm: options.approveLlm }
      : {}),
    ...(options.llmProvider ? { llmProvider: options.llmProvider } : {}),
    ...(maxLlmTokens === undefined ? {} : { maxLlmTokens }),
  };
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  const content = await readTextIfExists(file);
  if (!content) throw new Error(`Required artifact is missing: ${file}`);
  return record(JSON.parse(content), file);
}

function evidenceStatus(value: unknown, label: string): EvidenceStatus {
  if (
    value !== "single-source" &&
    value !== "corroborated" &&
    value !== "contested" &&
    value !== "experiment-supported" &&
    value !== "synthetic-only" &&
    value !== "insufficient"
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function validatePlan(
  value: unknown,
  selected: Array<Omit<CorroborationTarget, "supportQuery" | "challengeQuery">>,
): CorroborationTarget[] {
  const data = record(value, "corroboration plan");
  if (!Array.isArray(data.targets)) {
    throw new Error("corroboration plan targets must be an array");
  }
  const selectedById = new Map(selected.map((item) => [item.claimId, item]));
  const targets = data.targets.map((item, index) => {
    const entry = record(item, `targets[${index}]`);
    const claimId = requiredText(
      entry.claimId,
      `targets[${index}].claimId`,
      120,
    );
    const base = selectedById.get(claimId);
    if (!base)
      throw new Error("corroboration plan references an unknown Claim");
    return {
      ...base,
      supportQuery: requiredText(
        entry.supportQuery,
        `targets[${index}].supportQuery`,
        400,
      ),
      challengeQuery: requiredText(
        entry.challengeQuery,
        `targets[${index}].challengeQuery`,
        400,
      ),
    };
  });
  if (
    targets.length !== selected.length ||
    new Set(targets.map((item) => item.claimId)).size !== selected.length
  ) {
    throw new Error("corroboration plan must return every selected Claim once");
  }
  return targets;
}

export async function corroborateWiki(
  options: CorroborationOptions = {},
): Promise<CorroborationResult> {
  const config = await loadConfig(options.root);
  const [registry, summaryGraph, confidenceData] = await Promise.all([
    readJson(path.join(config.metaDir, "claims.json")),
    readJson(path.join(config.metaDir, "knowledge_graph.json")),
    readJson(path.join(config.metaDir, "claim_confidence.json")),
  ]);
  if (
    !Array.isArray(registry.claims) ||
    !Array.isArray(registry.sources) ||
    !Array.isArray(summaryGraph.claims) ||
    !Array.isArray(confidenceData.claims)
  ) {
    throw new Error("Malformed compiled corroboration artifacts");
  }
  const claims = registry.claims.map((item, index): ClaimRecord => {
    const claim = record(item, `claims[${index}]`);
    return {
      id: requiredText(claim.id, `claims[${index}].id`, 120),
      sourceId: requiredText(claim.sourceId, `claims[${index}].sourceId`, 120),
      statement: requiredText(claim.statement, `claims[${index}].statement`),
      quote: requiredText(claim.quote, `claims[${index}].quote`),
      topicIds: Array.isArray(claim.topicIds)
        ? claim.topicIds.map((id, topicIndex) =>
            requiredText(id, `claims[${index}].topicIds[${topicIndex}]`, 120),
          )
        : [],
    };
  });
  const sourceTitles = new Map(
    registry.sources.map((item, index) => {
      const source = record(item, `sources[${index}]`);
      return [
        requiredText(source.id, `sources[${index}].id`, 120),
        requiredText(source.title, `sources[${index}].title`, 1_000),
      ] as const;
    }),
  );
  const confidence = confidenceData.claims.map(
    (item, index): ConfidenceRecord => {
      const entry = record(item, `confidence[${index}]`);
      return {
        claimId: requiredText(
          entry.claimId,
          `confidence[${index}].claimId`,
          120,
        ),
        confidence: finiteNumber(
          entry.confidence,
          `confidence[${index}].confidence`,
        ),
        evidenceStatus: evidenceStatus(
          entry.evidenceStatus,
          `confidence[${index}].evidenceStatus`,
        ),
        independentSupportSources: finiteNumber(
          entry.independentSupportSources,
          `confidence[${index}].independentSupportSources`,
        ),
      };
    },
  );
  const confidenceById = new Map(
    confidence.map((entry) => [entry.claimId, entry]),
  );
  const summaryIds = new Set(
    summaryGraph.claims.map((item, index) =>
      requiredText(
        record(item, `summaryClaims[${index}]`).id,
        `summaryClaims[${index}].id`,
        120,
      ),
    ),
  );
  const planPath = path.join(config.metaDir, "corroboration_plan.json");
  const storedPlanContent = await readTextIfExists(planPath);
  let resumedTargets: CorroborationTarget[] | undefined;
  if (storedPlanContent) {
    const storedPlan = record(
      JSON.parse(storedPlanContent),
      "stored corroboration plan",
    );
    if (storedPlan.state === "planned" && Array.isArray(storedPlan.targets)) {
      resumedTargets = storedPlan.targets.map((item, index) => {
        const target = record(item, `stored targets[${index}]`);
        return {
          claimId: requiredText(
            target.claimId,
            `stored targets[${index}].claimId`,
            120,
          ),
          statement: requiredText(
            target.statement,
            `stored targets[${index}].statement`,
          ),
          sourceId: requiredText(
            target.sourceId,
            `stored targets[${index}].sourceId`,
            120,
          ),
          sourceTitle: requiredText(
            target.sourceTitle,
            `stored targets[${index}].sourceTitle`,
            1_000,
          ),
          confidence: finiteNumber(
            target.confidence,
            `stored targets[${index}].confidence`,
          ),
          evidenceStatus: evidenceStatus(
            target.evidenceStatus,
            `stored targets[${index}].evidenceStatus`,
          ),
          independentSupportSources: finiteNumber(
            target.independentSupportSources,
            `stored targets[${index}].independentSupportSources`,
          ),
          summaryClaim: target.summaryClaim === true,
          supportQuery: requiredText(
            target.supportQuery,
            `stored targets[${index}].supportQuery`,
            400,
          ),
          challengeQuery: requiredText(
            target.challengeQuery,
            `stored targets[${index}].challengeQuery`,
            400,
          ),
        };
      });
    }
  }
  const explicitIds = options.claimIds?.length
    ? new Set(options.claimIds)
    : undefined;
  if (explicitIds) {
    for (const id of explicitIds) {
      if (!claims.some((claim) => claim.id === id)) {
        throw new Error(`Unknown corroboration Claim ID: ${id}`);
      }
    }
  }
  const claimLimit = options.claimLimit ?? 3;
  if (!Number.isInteger(claimLimit) || claimLimit < 1 || claimLimit > 100) {
    throw new Error("claimLimit must be an integer from 1 to 100");
  }
  const summaryOnly = options.summaryOnly ?? true;
  const selected = resumedTargets
    ? []
    : claims
        .filter((claim) => {
          const current = confidenceById.get(claim.id);
          if (!current)
            throw new Error(`Missing confidence for Claim ${claim.id}`);
          if (explicitIds) return explicitIds.has(claim.id);
          if (summaryOnly && !summaryIds.has(claim.id)) return false;
          return (
            current.independentSupportSources < 1 &&
            current.evidenceStatus !== "contested" &&
            current.evidenceStatus !== "insufficient"
          );
        })
        .map((claim) => {
          const current = confidenceById.get(claim.id)!;
          return {
            claimId: claim.id,
            statement: claim.statement,
            sourceId: claim.sourceId,
            sourceTitle: sourceTitles.get(claim.sourceId) ?? claim.sourceId,
            confidence: current.confidence,
            evidenceStatus: current.evidenceStatus,
            independentSupportSources: current.independentSupportSources,
            summaryClaim: summaryIds.has(claim.id),
          };
        })
        .sort(
          (left, right) =>
            Number(right.summaryClaim) - Number(left.summaryClaim) ||
            left.confidence - right.confidence ||
            left.claimId.localeCompare(right.claimId),
        )
        .slice(0, claimLimit);
  if (!resumedTargets && !selected.length) {
    await writeText(
      planPath,
      JSON.stringify(
        {
          version: CORROBORATION_VERSION,
          generatedAt: (options.now?.() ?? new Date()).toISOString(),
          targets: [],
        },
        null,
        2,
      ),
    );
    return {
      planPath,
      targets: [],
      searches: [],
      imported: 0,
      compiled: false,
      before: [],
      after: [],
      usage: {},
    };
  }
  const planUsage = new LlmUsageTracker(options.maxLlmTokens);
  const model = cleanModel(process.env.ANTHROPIC_MODEL ?? config.llm.model);
  const planInput = selected.map((target) => {
    const claim = claims.find((item) => item.id === target.claimId)!;
    return {
      claimId: target.claimId,
      statement: target.statement,
      immutableQuote: claim.quote,
      sourceTitle: target.sourceTitle,
      topicIds: claim.topicIds,
    };
  });
  const planKey = sha256(
    JSON.stringify({
      version: CORROBORATION_VERSION,
      model,
      focus: config.researchFocus,
      targets: planInput,
    }),
  );
  const planCache = path.join(
    config.metaDir,
    "corroboration-plans",
    `${planKey}.json`,
  );
  const cachedPlan = await readTextIfExists(planCache);
  const targets =
    resumedTargets ??
    (cachedPlan
      ? validatePlan(JSON.parse(cachedPlan), selected)
      : await requestJson(
          requireLlm(config, options),
          {
            purpose: "corroboration-plan",
            maxTokens: Math.min(config.llm.synthesisOutputTokens, 4_000),
            prompt: `Create independent literature searches to corroborate or challenge each Claim for "${config.researchFocus}". Return JSON {targets:[{claimId,supportQuery,challengeQuery}]}. Return every Claim exactly once. Queries must be concise, standalone scholarly search phrases; supportQuery seeks independent confirming evidence, while challengeQuery seeks conflicting results, failure conditions, or scope limits. Do not merely copy the source title and do not assume the Claim is true.\n${JSON.stringify(planInput)}`,
          },
          (value) => validatePlan(value, selected),
          planUsage,
        ));
  if (!resumedTargets && !cachedPlan) {
    await writeText(planCache, JSON.stringify({ targets }, null, 2));
  }
  if (!resumedTargets) {
    await writeText(
      planPath,
      JSON.stringify(
        {
          version: CORROBORATION_VERSION,
          model,
          researchFocus: config.researchFocus,
          generatedAt: (options.now?.() ?? new Date()).toISOString(),
          state: "planned",
          baselineSourceIds: registry.sources.map((item, index) =>
            requiredText(
              record(item, `sources[${index}]`).id,
              `sources[${index}].id`,
              120,
            ),
          ),
          targets,
        },
        null,
        2,
      ),
    );
  }
  const frontierAdmission = await admitEvidenceClues(
    targets.flatMap((target) => [
      {
        query: target.supportQuery,
        targetId: target.claimId,
        problemId: target.claimId,
        topicId: inferEvidenceTopic(target.statement, "support"),
        kind: "support" as const,
        priority: Math.max(0, 100 - target.confidence),
      },
      {
        query: target.challengeQuery,
        targetId: target.claimId,
        problemId: target.claimId,
        topicId: inferEvidenceTopic(target.statement, "challenge"),
        kind: "challenge" as const,
        priority: Math.max(0, 100 - target.confidence),
      },
    ]),
    options,
  );
  const requiredClueIds = [
    ...new Set(
      frontierAdmission.clues
        .filter(
          (clue) =>
            clue.status === "pending" ||
            clue.status === "deferred" ||
            clue.status === "running",
        )
        .map((clue) => clue.id),
    ),
  ];
  const frontierSelection = await selectEvidenceClues({
    ...options,
    limit: Math.max(1, targets.length * 2),
    ids: requiredClueIds,
  });
  let frontierStatus = frontierSelection.status;
  let frontierIncomplete =
    frontierSelection.clues.length < requiredClueIds.length;
  const totalUsage: Required<LlmUsage> = {
    inputTokens: 0,
    outputTokens: 0,
  };
  addUsage(totalUsage, planUsage.result());
  let usedTokens = tokenTotal(totalUsage);
  const searches = [];
  const maximumDownloads =
    options.maxDownloads ?? config.search.maxDownloads ?? 3;
  let downloadAttempts = 0;
  try {
    for (const clue of frontierSelection.clues) {
      const searchOptions: SearchOptions & ServiceOptions = {
        ...childOptions(
          options,
          config.root,
          remainingTokens(options.maxLlmTokens, usedTokens),
        ),
        importResults: true,
        limit: options.limit ?? 3,
        fullText: options.fullText ?? false,
        oaOnly: options.oaOnly ?? true,
        maxDownloads: Math.max(0, maximumDownloads - downloadAttempts),
        maxFileBytes:
          options.maxFileBytes ??
          config.search.maxFileBytes ??
          100 * 1024 * 1024,
        onFullTextFailure: options.onFullTextFailure ?? "metadata",
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.providers ? { providers: options.providers } : {}),
        ...(options.from ? { from: options.from } : {}),
        ...(options.to ? { to: options.to } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      let run;
      try {
        run = await searchWiki(clue.query, searchOptions);
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
        throw error;
      }
      searches.push(run);
      downloadAttempts += run.fullTextAttempts ?? 0;
      addUsage(totalUsage, run.usage);
      usedTokens = tokenTotal(totalUsage);
      const clueError =
        run.results.length === 0 && run.errors.length
          ? run.errors.join("; ")
          : undefined;
      frontierStatus = await completeEvidenceClue(
        clue.id,
        {
          resultCount: run.results.length,
          importedCount: run.imported.length,
          ...(clueError ? { error: clueError } : {}),
        },
        options,
      );
      if (clueError) frontierIncomplete = true;
    }
    const compilation = await compileWiki(
      childOptions(
        options,
        config.root,
        remainingTokens(options.maxLlmTokens, usedTokens),
      ),
    );
    addUsage(totalUsage, compilation.usage);
    usedTokens = tokenTotal(totalUsage);
    const adjudication =
      options.adjudicate === false
        ? undefined
        : await adjudicateWiki(
            childOptions(
              options,
              config.root,
              remainingTokens(options.maxLlmTokens, usedTokens),
            ),
          );
    addUsage(totalUsage, adjudication?.usage);
    const afterData = await readJson(
      path.join(config.metaDir, "claim_confidence.json"),
    );
    if (!Array.isArray(afterData.claims)) {
      throw new Error("Malformed post-corroboration confidence artifact");
    }
    const afterById = new Map(
      afterData.claims.map((item, index) => {
        const entry = record(item, `afterConfidence[${index}]`);
        return [
          requiredText(entry.claimId, `afterConfidence[${index}].claimId`, 120),
          {
            claimId: requiredText(
              entry.claimId,
              `afterConfidence[${index}].claimId`,
              120,
            ),
            confidence: finiteNumber(
              entry.confidence,
              `afterConfidence[${index}].confidence`,
            ),
            evidenceStatus: evidenceStatus(
              entry.evidenceStatus,
              `afterConfidence[${index}].evidenceStatus`,
            ),
            independentSupportSources: finiteNumber(
              entry.independentSupportSources,
              `afterConfidence[${index}].independentSupportSources`,
            ),
          },
        ] as const;
      }),
    );
    const before = targets.map((target) => ({
      claimId: target.claimId,
      confidence: target.confidence,
      evidenceStatus: target.evidenceStatus,
      independentSupportSources: target.independentSupportSources,
    }));
    const after = targets.map((target) => {
      const current = afterById.get(target.claimId);
      if (!current) {
        throw new Error(
          `Target Claim disappeared after compile: ${target.claimId}`,
        );
      }
      return current;
    });
    const result: CorroborationResult = {
      planPath,
      targets,
      searches,
      imported: searches.reduce(
        (total, search) => total + search.imported.length,
        0,
      ),
      compiled: true,
      before,
      after,
      ...(adjudication ? { adjudication } : {}),
      frontier: frontierStatus,
      usage: totalUsage,
    };
    await writeText(
      path.join(config.metaDir, "corroboration_last_run.json"),
      JSON.stringify(
        {
          version: CORROBORATION_VERSION,
          completedAt: (options.now?.() ?? new Date()).toISOString(),
          ...result,
        },
        null,
        2,
      ),
    );
    await writeText(
      planPath,
      JSON.stringify(
        {
          version: CORROBORATION_VERSION,
          model,
          researchFocus: config.researchFocus,
          generatedAt: (options.now?.() ?? new Date()).toISOString(),
          state: frontierIncomplete ? "planned" : "completed",
          targets,
        },
        null,
        2,
      ),
    );
    return result;
  } catch (error) {
    if (error instanceof WikiLlmResponseError) {
      error.addUsage(totalUsage);
    }
    throw error;
  }
}
