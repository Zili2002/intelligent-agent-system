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
    allowedCommands: string[];
  };
}

/** Analysis configuration */
export interface AnalysisConfig {
  mode: "rule-based" | "llm" | "hybrid";
  llm?: {
    provider: "anthropic";
    model: string;
    maxTokens: number;
    inputCostPerMillionTokens: number;
    outputCostPerMillionTokens: number;
    thinking: {
      type: "disabled" | "adaptive";
      effort: "low" | "medium" | "high" | "xhigh" | "max";
    };
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
  wikiPath?: string;
  autoCompileWiki: boolean;
  autoLearnWiki: boolean;
  wikiSearchResultLimit: number;
  /** Separate approval for billable Wiki LLM compilation; experiment approval never enables it. */
  wikiLlm?: {
    approved: boolean;
    maxTokensPerSync: number;
  };
  maxIterations: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

/** Default configuration */
export const defaultConfig: AgentConfig = {
  sandbox: {
    type: "docker",
    docker: {
      image: "node:24-bookworm-slim",
      cpuLimit: 2,
      memoryLimit: "2g",
      diskLimit: "1g",
      networkMode: "none",
      timeout: 300, // 5 minutes
    },
    local: {
      timeout: 300,
      allowedCommands: ["node"],
    },
  },
  analysis: {
    mode: "hybrid",
    llm: {
      provider: "anthropic",
      model: "claude-opus-4-8",
      maxTokens: 16000,
      inputCostPerMillionTokens: 0,
      outputCostPerMillionTokens: 0,
      thinking: {
        type: "adaptive",
        effort: "high",
      },
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
  autoCompileWiki: true,
  autoLearnWiki: false,
  wikiSearchResultLimit: 3,
  wikiLlm: {
    approved: false,
    maxTokensPerSync: 12000,
  },
  maxIterations: 10,
  logLevel: "info",
};
