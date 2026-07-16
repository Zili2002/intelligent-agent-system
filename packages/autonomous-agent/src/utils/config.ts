/**
 * Agent configuration loading, validation, and persistence.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "../types/config.js";
import { defaultConfig } from "../types/config.js";

const CONFIG_FILE = ".agent-config.json";

export async function loadConfig(
  root: string = process.cwd(),
): Promise<AgentConfig> {
  const configPath = path.join(root, CONFIG_FILE);
  let config = structuredClone(defaultConfig);

  if (existsSync(configPath)) {
    const content = await readFile(configPath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`${configPath} must contain a JSON object`);
    }
    config = mergeConfig(defaultConfig, parsed as Partial<AgentConfig>);
  }

  if (process.env.WIKI_PATH) {
    config.wikiPath = process.env.WIKI_PATH;
  }
  if (process.env.AGENT_SANDBOX) {
    if (
      process.env.AGENT_SANDBOX !== "docker" &&
      process.env.AGENT_SANDBOX !== "local" &&
      process.env.AGENT_SANDBOX !== "hybrid"
    ) {
      throw new Error(
        "AGENT_SANDBOX must be docker, local, or hybrid when configured",
      );
    }
    config.sandbox.type = process.env.AGENT_SANDBOX;
  }
  if (process.env.ANTHROPIC_MODEL && config.analysis.llm) {
    config.analysis.llm.model = process.env.ANTHROPIC_MODEL.replace(
      // Strip terminal formatting accidentally persisted by shell-managed settings.
      /\u001B\[[0-?]*[ -/]*[@-~]/g,
      "",
    )
      .replace(/\[[0-9;]*m\]?/g, "")
      .trim();
  }

  validateConfig(config);
  return config;
}

export async function saveConfig(
  config: AgentConfig,
  root: string = process.cwd(),
): Promise<void> {
  validateConfig(config);
  await mkdir(root, { recursive: true });
  const configPath = path.join(root, CONFIG_FILE);
  const temporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporary, configPath);
}

export async function initConfig(root: string = process.cwd()): Promise<void> {
  const configPath = path.join(root, CONFIG_FILE);
  if (!existsSync(configPath)) {
    await saveConfig(structuredClone(defaultConfig), root);
  }
}

export function validateConfig(config: AgentConfig): void {
  if (!Number.isInteger(config.maxIterations) || config.maxIterations <= 0) {
    throw new Error("maxIterations must be a positive integer");
  }
  if (
    !Number.isInteger(config.wikiSearchResultLimit) ||
    config.wikiSearchResultLimit < 1 ||
    config.wikiSearchResultLimit > 100
  ) {
    throw new Error("wikiSearchResultLimit must be an integer from 1 to 100");
  }
  if (
    !config.wikiLlm ||
    typeof config.wikiLlm.approved !== "boolean" ||
    !Number.isInteger(config.wikiLlm.maxTokensPerSync) ||
    config.wikiLlm.maxTokensPerSync < 1
  ) {
    throw new Error(
      "wikiLlm must define approved as a boolean and maxTokensPerSync as a positive integer",
    );
  }

  if (
    (config.sandbox.type === "docker" || config.sandbox.type === "hybrid") &&
    !config.sandbox.docker
  ) {
    throw new Error(`${config.sandbox.type} sandbox requires docker settings`);
  }
  if (
    (config.sandbox.type === "local" || config.sandbox.type === "hybrid") &&
    !config.sandbox.local
  ) {
    throw new Error(`${config.sandbox.type} sandbox requires local settings`);
  }
  if (
    config.sandbox.local &&
    config.sandbox.local.allowedCommands.length === 0
  ) {
    throw new Error("sandbox.local.allowedCommands cannot be empty");
  }

  const thresholds = config.budget.alerts;
  if (
    thresholds.warnAt < 0 ||
    thresholds.warnAt > 100 ||
    thresholds.stopAt <= 0 ||
    thresholds.stopAt > 100 ||
    thresholds.warnAt >= thresholds.stopAt
  ) {
    throw new Error("budget alerts must satisfy 0 <= warnAt < stopAt <= 100");
  }

  if (
    config.budget.autoApprove.maxComputeHoursPerExperiment <= 0 ||
    config.budget.autoApprove.maxTokensPerExperiment <= 0
  ) {
    throw new Error("auto-approval limits must be positive");
  }

  if (
    config.analysis.llm &&
    (config.analysis.llm.inputCostPerMillionTokens < 0 ||
      config.analysis.llm.outputCostPerMillionTokens < 0)
  ) {
    throw new Error("LLM token pricing values cannot be negative");
  }
  if (
    config.analysis.llm &&
    config.analysis.llm.thinking.type !== "disabled" &&
    config.analysis.llm.thinking.type !== "adaptive"
  ) {
    throw new Error(
      'analysis.llm.thinking.type must be "disabled" or "adaptive"',
    );
  }
  if (
    config.analysis.llm &&
    !["low", "medium", "high", "xhigh", "max"].includes(
      config.analysis.llm.thinking.effort,
    )
  ) {
    throw new Error(
      "analysis.llm.thinking.effort must be low, medium, high, xhigh, or max",
    );
  }
}

function mergeConfig(
  defaults: AgentConfig,
  user: Partial<AgentConfig>,
): AgentConfig {
  const defaultLlm = defaults.analysis.llm;
  return {
    sandbox: {
      ...defaults.sandbox,
      ...user.sandbox,
      docker: user.sandbox?.docker
        ? { ...defaults.sandbox.docker, ...user.sandbox.docker }
        : defaults.sandbox.docker,
      local: user.sandbox?.local
        ? { ...defaults.sandbox.local, ...user.sandbox.local }
        : defaults.sandbox.local,
    },
    analysis: {
      ...defaults.analysis,
      ...user.analysis,
      llm: user.analysis?.llm
        ? {
            ...defaultLlm!,
            ...user.analysis.llm,
            thinking: user.analysis.llm.thinking
              ? {
                  ...defaultLlm!.thinking,
                  ...user.analysis.llm.thinking,
                }
              : defaultLlm!.thinking,
          }
        : defaults.analysis.llm,
    },
    budget: {
      ...defaults.budget,
      ...user.budget,
      autoApprove: user.budget?.autoApprove
        ? { ...defaults.budget.autoApprove, ...user.budget.autoApprove }
        : defaults.budget.autoApprove,
      alerts: user.budget?.alerts
        ? { ...defaults.budget.alerts, ...user.budget.alerts }
        : defaults.budget.alerts,
    },
    wikiPath: user.wikiPath ?? defaults.wikiPath,
    autoCompileWiki: user.autoCompileWiki ?? defaults.autoCompileWiki,
    autoLearnWiki: user.autoLearnWiki ?? defaults.autoLearnWiki,
    wikiSearchResultLimit:
      user.wikiSearchResultLimit ?? defaults.wikiSearchResultLimit,
    wikiLlm: user.wikiLlm
      ? { ...defaults.wikiLlm, ...user.wikiLlm }
      : defaults.wikiLlm,
    maxIterations: user.maxIterations ?? defaults.maxIterations,
    logLevel: user.logLevel || defaults.logLevel,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
