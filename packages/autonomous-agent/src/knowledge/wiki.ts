/**
 * Bridge verified experiment evidence into the companion research wiki.
 */

import path from "node:path";
import {
  WikiCompiler,
  WikiLlmResponseError,
  type CompileResult,
  type IngestResult,
  type LlmProvider,
  type LearnResult,
  type ReflectResult,
  type WikiStatus,
} from "@intelligent-agent-system/llm-wiki-compiler";
import { saveMissionState } from "../mission/manager.js";
import type { AgentConfig } from "../types/config.js";
import type { Experiment } from "../types/experiment.js";
import type { Reflection } from "../types/exploration.js";
import type { Mission } from "../types/mission.js";

export interface WikiSyncResult {
  root: string;
  ingestion: IngestResult;
  compilation: CompileResult;
  reflection: ReflectResult;
  learning?: LearnResult;
  status: WikiStatus;
}

export async function syncExperimentToWiki(
  mission: Mission,
  experiment: Experiment,
  reflection: Reflection,
  config: AgentConfig,
  agentRoot: string,
  llmProvider?: LlmProvider,
): Promise<WikiSyncResult | undefined> {
  if (!config.wikiPath || !config.autoCompileWiki || !experiment.analysis) {
    return undefined;
  }
  if (!config.wikiLlm?.approved) {
    throw new Error(
      "Wiki synchronization requires separate Wiki LLM approval (wikiLlm.approved: true); experiment approval and budgets do not approve Wiki calls.",
    );
  }

  const wikiRoot = path.resolve(agentRoot, config.wikiPath);
  const wiki = new WikiCompiler({ root: wikiRoot });
  await wiki.init();
  const ingestion = await wiki.ingestContent(
    experimentEvidence(mission, experiment, reflection),
    experiment.id,
    {
      title: `${mission.name}: ${experiment.id}`,
      mediaType: "application/vnd.llmwiki.experiment+markdown",
      provenanceKind: "experiment",
    },
  );
  const missionRemaining =
    mission.budget.llmTokens > 0
      ? mission.budget.llmTokens - mission.budget.llmTokensUsed
      : Number.POSITIVE_INFINITY;
  let remaining = Math.min(missionRemaining, config.wikiLlm.maxTokensPerSync);
  if (remaining < 1) {
    throw new Error(
      "Mission LLM token budget cannot cover Wiki synchronization",
    );
  }
  let wikiTokensUsed = 0;
  const useTokens = (usage?: {
    inputTokens?: number;
    outputTokens?: number;
  }) => {
    const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    wikiTokensUsed += tokens;
    remaining -= tokens;
  };
  const options = () => ({
    root: wikiRoot,
    approveLlm: true,
    maxLlmTokens: Math.max(1, Math.floor(remaining)),
    ...(llmProvider ? { llmProvider } : {}),
  });

  let compilation: CompileResult;
  let wikiReflection: ReflectResult;
  let learning: LearnResult | undefined;
  try {
    compilation = await new WikiCompiler(options()).compile();
    useTokens(compilation.usage);
    wikiReflection = await new WikiCompiler(options()).reflect();
    useTokens(wikiReflection.usage);
    learning = config.autoLearnWiki
      ? await new WikiCompiler(options()).learn({
          gapLimit: Math.max(
            1,
            Math.min(experiment.analysis.knowledgeGaps.length || 1, 3),
          ),
          limit: config.wikiSearchResultLimit,
        })
      : undefined;
    useTokens(learning?.usage);
  } catch (error) {
    if (error instanceof WikiLlmResponseError) {
      wikiTokensUsed += (error.inputTokens ?? 0) + (error.outputTokens ?? 0);
    }
    mission.budget.llmTokensUsed += wikiTokensUsed;
    await saveMissionState(mission, agentRoot);
    throw error;
  }
  mission.budget.llmTokensUsed += wikiTokensUsed;
  await saveMissionState(mission, agentRoot);
  if (
    learning &&
    learning.selectedGaps.length > 0 &&
    learning.imported === 0 &&
    learning.searches.every(
      (search) => search.results.length === 0 && search.errors.length > 0,
    )
  ) {
    throw new Error(
      `Active Wiki learning failed: ${learning.searches
        .flatMap((search) => search.errors)
        .join("; ")}`,
    );
  }
  const status = await wiki.status();

  return {
    root: wikiRoot,
    ingestion,
    compilation,
    reflection: wikiReflection,
    ...(learning ? { learning } : {}),
    status,
  };
}

function experimentEvidence(
  mission: Mission,
  experiment: Experiment,
  reflection: Reflection,
): string {
  const analysis = experiment.analysis;
  if (!analysis) {
    throw new Error(`Experiment ${experiment.id} has no verified analysis`);
  }
  const syntheticSimulation =
    /AgentSimulator|simulateAgentCycle|Math\.random/.test(
      experiment.design.code ?? "",
    );

  return `# ${mission.name}: ${experiment.id}

## Mission

- Mission ID: ${mission.id}
- Objective: ${mission.objective}
- Iteration: ${mission.iteration}

## Hypothesis

${experiment.hypothesis.statement}

Rationale: ${experiment.hypothesis.rationale}

## Execution evidence

- Status: ${experiment.status}
- Evidence class: ${syntheticSimulation ? "synthetic simulation" : "locally executed generated experiment"}
- Exit code: ${experiment.execution?.exitCode ?? "not recorded"}
- Duration seconds: ${experiment.execution?.durationSeconds ?? "not recorded"}
- Hypothesis supported: ${analysis.hypothesisSupported ?? "inconclusive"}

## Evidence limitations

${
  syntheticSimulation
    ? "- Measurements describe the generated simulator only; they do not measure the production autonomous-agent runtime.\n- Randomized tool success and recovery outcomes are synthetic and must not be generalized as observed system reliability."
    : "- Measurements apply only to the reviewed experiment code, inputs, sandbox, and execution run."
}

## Metric updates

${
  Object.entries(analysis.metricUpdates)
    .map(([name, value]) => `- ${name}: ${value}`)
    .join("\n") || "- None"
}

## Measurements

\`\`\`json
${JSON.stringify(analysis.measurements, null, 2)}
\`\`\`

## Verified findings

${analysis.insights.map((finding) => `- ${finding}`).join("\n") || "- None"}

## Unexpected findings

${
  analysis.unexpectedFindings.map((finding) => `- ${finding}`).join("\n") ||
  "- None"
}

## Knowledge gaps

${analysis.knowledgeGaps.map((gap) => `- ${gap}`).join("\n") || "- None"}

## Reflection

${reflection.lessonsLearned.map((lesson) => `- ${lesson}`).join("\n") || "- None"}
`;
}
