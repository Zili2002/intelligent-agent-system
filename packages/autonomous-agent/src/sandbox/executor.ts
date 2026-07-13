/**
 * Sandbox manager - unified interface for executing experiments.
 */

import path from "path";
import type { Experiment } from "../types/experiment.js";
import type { AgentConfig } from "../types/config.js";
import type { ExecutionResult } from "../types/sandbox.js";
import { executeInDocker } from "./docker.js";
import { executeInLocal } from "./local.js";

/**
 * Execute an experiment in the configured sandbox.
 */
export async function executeExperiment(
  experiment: Experiment,
  config: AgentConfig,
  experimentDir: string,
): Promise<ExecutionResult> {
  const entrypoint =
    experiment.design.entrypoint ??
    defaultEntrypoint(experiment.design.codeLanguage);
  const scriptPath = path.join(experimentDir, entrypoint);
  const runtime = runtimeFor(experiment.design.codeLanguage);

  console.log(`🔬 Executing experiment: ${experiment.id}`);
  console.log(`   Sandbox: ${config.sandbox.type}`);
  console.log(`   Timeout: ${getSandboxTimeout(config)}s`);

  const options = {
    workDir: experimentDir,
    timeout: getSandboxTimeout(config),
    command: runtime.command,
    args: [scriptPath],
    env: {
      EXPERIMENT_ID: experiment.id,
      MISSION_ID: experiment.missionId,
    },
  };

  try {
    let result: ExecutionResult;

    switch (config.sandbox.type) {
      case "docker":
        result = await executeInDocker(scriptPath, config.sandbox, options);
        break;

      case "local":
        result = await executeInLocal(scriptPath, config.sandbox, options);
        break;

      case "hybrid":
        // Use Docker for experiments, local for simple tasks
        const isSimple = experiment.design.expectedDuration === "< 1 minute";
        if (isSimple && config.sandbox.local) {
          result = await executeInLocal(scriptPath, config.sandbox, options);
        } else {
          result = await executeInDocker(scriptPath, config.sandbox, options);
        }
        break;

      default:
        throw new Error(`Unknown sandbox type: ${config.sandbox.type}`);
    }

    logExecutionResult(result);
    return result;
  } catch (error) {
    console.error(`❌ Execution failed: ${(error as Error).message}`);
    throw error;
  }
}

function defaultEntrypoint(
  language: Experiment["design"]["codeLanguage"],
): string {
  switch (language) {
    case "python":
      return "experiment.py";
    case "bash":
      return "experiment.sh";
    case "typescript":
      return "experiment.ts";
    case "javascript":
    case undefined:
      return "experiment.mjs";
  }
}

function runtimeFor(language: Experiment["design"]["codeLanguage"]): {
  command: string;
} {
  switch (language) {
    case "python":
      return {
        command: process.platform === "win32" ? "python" : "python3",
      };
    case "bash":
      return { command: "bash" };
    case "typescript":
      return { command: "tsx" };
    case "javascript":
    case undefined:
      return { command: process.execPath };
  }
}

function getSandboxTimeout(config: AgentConfig): number {
  if (
    (config.sandbox.type === "docker" || config.sandbox.type === "hybrid") &&
    config.sandbox.docker
  ) {
    return config.sandbox.docker.timeout;
  }
  if (config.sandbox.type === "local" && config.sandbox.local) {
    return config.sandbox.local.timeout;
  }
  return 300; // Default 5 minutes
}

function logExecutionResult(result: ExecutionResult): void {
  if (result.success) {
    console.log(`✅ Execution completed successfully`);
    console.log(`   Duration: ${result.duration.toFixed(2)}s`);
    console.log(`   Memory: ${result.resourceUsage.memoryPeak}`);
  } else {
    console.log(`❌ Execution failed (exit code: ${result.exitCode})`);
    console.log(`   Duration: ${result.duration.toFixed(2)}s`);
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
  }
}
