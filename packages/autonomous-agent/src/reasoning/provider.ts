/**
 * Reasoning provider selection and Anthropic-backed experiment design.
 */

import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { designExperiment } from "../exploration/design.js";
import type { AgentConfig } from "../types/config.js";
import type { Experiment, Hypothesis } from "../types/experiment.js";
import type { Mission } from "../types/mission.js";

export interface DesignOutcome {
  experiment: Experiment;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  provider: "rule-based" | "anthropic";
}

interface LlmExperimentDesign {
  description: string;
  steps: string[];
  code: string;
  expectedDuration: string;
  resourceEstimate: {
    cpu: number;
    memory: string;
    disk: string;
  };
}

export interface ExperimentDesignPlan {
  usesAnthropic: boolean;
  estimatedInputTokens: number;
  requestedOutputTokens: number;
  estimatedTotalTokens: number;
  estimatedCostUsd: number;
}

const DESIGN_SYSTEM_PROMPT =
  "You design safe, reproducible research experiments. Return only valid JSON. Never invent existing measurements or claim an experiment has run.";

export function planExperimentDesign(
  mission: Mission,
  hypothesis: Hypothesis,
  config: AgentConfig,
): ExperimentDesignPlan {
  const llmConfig = config.analysis.llm;
  const usesAnthropic =
    config.analysis.mode !== "rule-based" &&
    Boolean(process.env.ANTHROPIC_API_KEY) &&
    llmConfig?.provider === "anthropic";
  if (!usesAnthropic || !llmConfig) {
    return {
      usesAnthropic: false,
      estimatedInputTokens: 0,
      requestedOutputTokens: 0,
      estimatedTotalTokens: 0,
      estimatedCostUsd: 0,
    };
  }

  const prompt = buildDesignPrompt(mission, hypothesis);
  const estimatedInputTokens =
    Buffer.byteLength(`${DESIGN_SYSTEM_PROMPT}\n${prompt}`, "utf8") + 128;
  const remainingTokens =
    mission.budget.llmTokens > 0
      ? mission.budget.llmTokens - mission.budget.llmTokensUsed
      : Number.POSITIVE_INFINITY;
  const requestedOutputTokens = Math.max(
    0,
    Math.min(llmConfig.maxTokens, remainingTokens - estimatedInputTokens),
  );

  return {
    usesAnthropic: true,
    estimatedInputTokens,
    requestedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + requestedOutputTokens,
    estimatedCostUsd:
      (estimatedInputTokens / 1_000_000) * llmConfig.inputCostPerMillionTokens +
      (requestedOutputTokens / 1_000_000) *
        llmConfig.outputCostPerMillionTokens,
  };
}

export async function designExperimentForMission(
  mission: Mission,
  hypothesis: Hypothesis,
  config: AgentConfig,
): Promise<DesignOutcome> {
  const llmConfig = config.analysis.llm;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (config.analysis.mode === "rule-based") {
    return offlineOutcome(mission, hypothesis);
  }

  if (!apiKey) {
    if (config.analysis.mode === "llm") {
      throw new Error(
        "analysis.mode is llm but ANTHROPIC_API_KEY is not configured",
      );
    }
    console.warn(
      "ANTHROPIC_API_KEY is not configured; using the transparent offline experiment designer",
    );
    return offlineOutcome(mission, hypothesis);
  }

  if (!llmConfig || llmConfig.provider !== "anthropic") {
    throw new Error(
      "Only the Anthropic reasoning provider is currently implemented",
    );
  }

  const plan = planExperimentDesign(mission, hypothesis, config);
  if (!plan.usesAnthropic || plan.requestedOutputTokens <= 0) {
    throw new Error(
      "Mission LLM token budget cannot cover the estimated input and output tokens",
    );
  }

  const client = new Anthropic({ apiKey });
  const prompt = buildDesignPrompt(mission, hypothesis);
  const response = await client.messages.create({
    model: llmConfig.model,
    max_tokens: plan.requestedOutputTokens,
    temperature: 0,
    system: DESIGN_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });
  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  const design = parseDesign(text);

  return {
    experiment: {
      id: `exp-${randomUUID()}`,
      missionId: mission.id,
      hypothesis,
      status: "designed",
      design: {
        ...design,
        codeLanguage: "javascript",
        entrypoint: "experiment.mjs",
        origin: "anthropic",
      },
      createdAt: new Date().toISOString(),
    },
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    estimatedCostUsd:
      (response.usage.input_tokens / 1_000_000) *
        llmConfig.inputCostPerMillionTokens +
      (response.usage.output_tokens / 1_000_000) *
        llmConfig.outputCostPerMillionTokens,
    provider: "anthropic",
  };
}

function offlineOutcome(
  mission: Mission,
  hypothesis: Hypothesis,
): DesignOutcome {
  return {
    experiment: designExperiment(mission, hypothesis),
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    provider: "rule-based",
  };
}

function buildDesignPrompt(mission: Mission, hypothesis: Hypothesis): string {
  return `Design one experiment for this mission and hypothesis.

Mission:
${JSON.stringify(
  {
    name: mission.name,
    objective: mission.objective,
    constraints: mission.constraints,
    successMetrics: mission.successMetrics,
    iteration: mission.iteration,
  },
  null,
  2,
)}

Hypothesis:
${JSON.stringify(hypothesis, null, 2)}

Return this exact JSON shape:
{
  "description": "string",
  "steps": ["string"],
  "code": "complete JavaScript ESM source",
  "expectedDuration": "< 5 minutes",
  "resourceEstimate": {"cpu": 1, "memory": "128MB", "disk": "10MB"}
}

The JavaScript must:
- use only Node.js built-ins;
- make no network requests and start no child processes;
- read and write only inside the current working directory;
- execute the actual proposed measurement or intervention;
- write results.json with status, hypothesisSupported, measurements,
  metricUpdates, findings, unexpectedFindings, knowledgeGaps, and nextSteps;
- set runId to process.env.EXPERIMENT_RUN_ID in results.json;
- use exact success-metric names for metricUpdates;
- report null or inconclusive when evidence cannot support a conclusion;
- not contain Markdown fences.`;
}

function parseDesign(text: string): LlmExperimentDesign {
  const normalized = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const parsed = JSON.parse(normalized) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("LLM experiment design must be a JSON object");
  }
  if (
    typeof parsed.description !== "string" ||
    !stringArray(parsed.steps) ||
    typeof parsed.code !== "string" ||
    typeof parsed.expectedDuration !== "string" ||
    !isRecord(parsed.resourceEstimate) ||
    typeof parsed.resourceEstimate.cpu !== "number" ||
    typeof parsed.resourceEstimate.memory !== "string" ||
    typeof parsed.resourceEstimate.disk !== "string"
  ) {
    throw new Error("LLM experiment design did not match the required schema");
  }

  return {
    description: parsed.description,
    steps: parsed.steps,
    code: parsed.code,
    expectedDuration: parsed.expectedDuration,
    resourceEstimate: {
      cpu: parsed.resourceEstimate.cpu,
      memory: parsed.resourceEstimate.memory,
      disk: parsed.resourceEstimate.disk,
    },
  };
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
