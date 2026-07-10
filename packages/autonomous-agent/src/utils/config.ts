/**
 * Configuration manager - loads and validates agent configuration.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { existsSync } from "fs";
import type { AgentConfig } from "../types/config.js";
import { defaultConfig } from "../types/config.js";

const CONFIG_FILE = ".agent-config.json";

/**
 * Load configuration from file or use defaults.
 */
export async function loadConfig(root: string = process.cwd()): Promise<AgentConfig> {
  const configPath = path.join(root, CONFIG_FILE);

  if (existsSync(configPath)) {
    const content = await readFile(configPath, "utf-8");
    const userConfig = JSON.parse(content);
    return mergeConfig(defaultConfig, userConfig);
  }

  return defaultConfig;
}

/**
 * Save configuration to file.
 */
export async function saveConfig(
  config: AgentConfig,
  root: string = process.cwd()
): Promise<void> {
  const configPath = path.join(root, CONFIG_FILE);
  await writeFile(configPath, JSON.stringify(config, null, 2));
}

/**
 * Initialize configuration file if it doesn't exist.
 */
export async function initConfig(root: string = process.cwd()): Promise<void> {
  const configPath = path.join(root, CONFIG_FILE);

  if (!existsSync(configPath)) {
    await saveConfig(defaultConfig, root);
  }
}

/**
 * Deep merge user config with defaults.
 */
function mergeConfig(defaults: AgentConfig, user: Partial<AgentConfig>): AgentConfig {
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
        ? { ...defaults.analysis.llm, ...user.analysis.llm }
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
    logLevel: user.logLevel || defaults.logLevel,
  };
}
