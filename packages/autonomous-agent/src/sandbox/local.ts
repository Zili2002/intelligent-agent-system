/**
 * Local process executor - runs experiments in local processes.
 * Used as fallback when Docker is not available.
 */

import { spawn } from "child_process";
import type {
  ExecutionResult,
  ExecutionOptions,
} from "../types/sandbox.js";
import type { SandboxConfig } from "../types/config.js";

/**
 * Execute code in a local process.
 */
export async function executeInLocal(
  scriptPath: string,
  config: SandboxConfig,
  options: ExecutionOptions
): Promise<ExecutionResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const process = spawn("python3", [scriptPath], {
      cwd: options.workDir,
      env: { ...process.env, ...options.env },
      timeout: config.local!.timeout * 1000,
    });

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      const duration = (Date.now() - startTime) / 1000;

      resolve({
        success: code === 0,
        exitCode: code || 0,
        stdout,
        stderr,
        duration,
        resourceUsage: {
          cpuTime: 0,
          memoryPeak: "unknown",
          diskUsed: "unknown",
        },
      });
    });

    process.on("error", (error) => {
      const duration = (Date.now() - startTime) / 1000;

      resolve({
        success: false,
        exitCode: -1,
        stdout,
        stderr: stderr + "\n" + error.message,
        duration,
        resourceUsage: {
          cpuTime: 0,
          memoryPeak: "unknown",
          diskUsed: "unknown",
        },
        error: error.message,
      });
    });
  });
}
