/**
 * Local process executor - runs experiments in local processes.
 * Used as fallback when Docker is not available.
 */

import { spawn } from "node:child_process";
import type { ExecutionResult, ExecutionOptions } from "../types/sandbox.js";
import type { SandboxConfig } from "../types/config.js";

/**
 * Execute code in a local process.
 */
export async function executeInLocal(
  scriptPath: string,
  config: SandboxConfig,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const localConfig = config.local;
  if (!localConfig) {
    throw new Error("Local sandbox configuration is missing");
  }

  const commandName = options.command.replace(/\\/g, "/").split("/").pop();

  if (
    !commandName ||
    !localConfig.allowedCommands.some(
      (allowed) =>
        allowed.toLowerCase() === commandName.toLowerCase() ||
        (allowed === "node" &&
          options.command.toLowerCase() === process.execPath.toLowerCase()),
    )
  ) {
    throw new Error(
      `Command ${options.command} is not in sandbox.allowedCommands`,
    );
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const maxOutputBytes = 10 * 1024 * 1024;

    const child = spawn(options.command, options.args, {
      cwd: options.workDir,
      env: safeEnvironment(options.env),
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeout * 1000);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (Buffer.byteLength(stdout) > maxOutputBytes) {
        child.kill();
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (Buffer.byteLength(stderr) > maxOutputBytes) {
        child.kill();
      }
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const duration = (Date.now() - startTime) / 1000;
      const outputExceeded =
        Buffer.byteLength(stdout) > maxOutputBytes ||
        Buffer.byteLength(stderr) > maxOutputBytes;
      const error = timedOut
        ? `Execution timed out after ${options.timeout}s`
        : outputExceeded
          ? "Execution output exceeded 10MB"
          : signal
            ? `Execution terminated by signal ${signal}`
            : undefined;

      resolve({
        success: code === 0 && !error,
        exitCode: code ?? -1,
        stdout,
        stderr,
        duration,
        resourceUsage: {
          cpuTime: 0,
          memoryPeak: "unknown",
          diskUsed: "unknown",
        },
        error,
      });
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
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

function safeEnvironment(
  experimentEnvironment: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const allowedHostKeys =
    process.platform === "win32"
      ? ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "Path", "PATHEXT"]
      : ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ"];
  const environment: NodeJS.ProcessEnv = {
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };

  for (const key of allowedHostKeys) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }

  for (const [key, value] of Object.entries(experimentEnvironment ?? {})) {
    environment[key] = value;
  }

  return environment;
}
