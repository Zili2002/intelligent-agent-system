/**
 * Configuration type definitions for the autonomous agent system.
 */

/** Sandbox configuration */
export interface SandboxConfig {
  type: "docker" | "local" | "hybrid";
  docker?: {
    image: string;
    cpuLimit: number;
    memoryLimit: string;
    diskLimit: string;
    networkMode: "none" | "bridge" | "host";
    timeout: number; // seconds
  };
  local?: {
    timeout: number;
    allowedCommands?: string[];
  };
}

/** Analysis configuration */
export interface AnalysisConfig {
  mode: "rule-based" | "llm" | "hybrid";
  llm?: {
    provider: "anthropic" | "openai";
    model: string;
    maxTokens: number;
  };
}

/** Budget configuration */
export interface BudgetConfig {
  autoApprove: {
    enabled: boolean;
    maxTokensPerExperiment: number;
    maxComputeHoursPerExperiment: number;
  };
  alerts: {
    warnAt: number; // percentage
    stopAt: number; // percentage
  };
}

/** Agent configuration */
export interface AgentConfig {
  sandbox: SandboxConfig;
  analysis: AnalysisConfig;
  budget: BudgetConfig;
  logLevel: "debug" | "info" | "warn" | "error";
}

/** Default configuration */
export const defaultConfig: AgentConfig = {
  sandbox: {
    type: "docker",
    docker: {
      image: "python:3.11-slim",
      cpuLimit: 2,
      memoryLimit: "2g",
      diskLimit: "1g",
      networkMode: "none",
      timeout: 300, // 5 minutes
    },
  },
  analysis: {
    mode: "hybrid",
    llm: {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      maxTokens: 4096,
    },
  },
  budget: {
    autoApprove: {
      enabled: true,
      maxTokensPerExperiment: 100000,
      maxComputeHoursPerExperiment: 0.5,
    },
    alerts: {
      warnAt: 80,
      stopAt: 95,
    },
  },
  logLevel: "info",
};
