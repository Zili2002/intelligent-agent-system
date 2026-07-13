/**
 * Bridge verified experiment evidence into the companion research wiki.
 */

import path from "node:path";
import {
  WikiCompiler,
  type CompileResult,
  type IngestResult,
  type LearnResult,
  type ReflectResult,
  type WikiStatus,
} from "@intelligent-agent-system/llm-wiki-compiler";
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
): Promise<WikiSyncResult | undefined> {
  if (!config.wikiPath || !config.autoCompileWiki || !experiment.analysis) {
    return undefined;
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
  const compilation = await wiki.compile();
  const wikiReflection = await wiki.reflect();
  const learning = config.autoLearnWiki
    ? await wiki.learn({
        gapLimit: Math.max(
          1,
          Math.min(experiment.analysis.knowledgeGaps.length || 1, 3),
        ),
        limit: config.wikiSearchResultLimit,
      })
    : undefined;
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
- Exit code: ${experiment.execution?.exitCode ?? "not recorded"}
- Duration seconds: ${experiment.execution?.durationSeconds ?? "not recorded"}
- Hypothesis supported: ${analysis.hypothesisSupported ?? "inconclusive"}

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
