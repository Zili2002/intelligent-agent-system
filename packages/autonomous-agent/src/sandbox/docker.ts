/**
 * Docker sandbox executor.
 *
 * Experiment directories are mounted into an isolated container. Network
 * access and resources are constrained by the agent configuration.
 */

import path from "node:path";
import Docker from "dockerode";
import type { SandboxConfig } from "../types/config.js";
import type { ExecutionOptions, ExecutionResult } from "../types/sandbox.js";

interface DockerError extends Error {
  statusCode?: number;
}

/**
 * Execute a Python experiment inside Docker.
 */
export async function executeInDocker(
  scriptPath: string,
  config: SandboxConfig,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  if (!config.docker) {
    throw new Error("Docker sandbox configuration is missing");
  }

  const docker = new Docker();
  const dockerConfig = config.docker;
  const startedAt = Date.now();
  let container: Docker.Container | undefined;

  await ensureImage(docker, dockerConfig.image);

  try {
    container = await docker.createContainer({
      Image: dockerConfig.image,
      Cmd: [
        dockerCommand(options.command),
        ...options.args.map((argument) =>
          path.resolve(argument) === path.resolve(scriptPath)
            ? `/workspace/${path.basename(scriptPath)}`
            : argument,
        ),
      ],
      WorkingDir: "/workspace",
      Env: [
        "PYTHONDONTWRITEBYTECODE=1",
        ...Object.entries(options.env ?? {}).map(
          ([key, value]) => `${key}=${value}`,
        ),
      ],
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        AutoRemove: false,
        Binds: [`${path.resolve(options.workDir)}:/workspace:rw`],
        CapDrop: ["ALL"],
        Memory: parseMemory(dockerConfig.memoryLimit),
        NanoCpus: Math.max(
          1,
          Math.floor(dockerConfig.cpuLimit * 1_000_000_000),
        ),
        NetworkMode: dockerConfig.networkMode,
        PidsLimit: 64,
        ReadonlyRootfs: true,
        SecurityOpt: ["no-new-privileges"],
        Tmpfs: {
          "/tmp": "rw,noexec,nosuid,size=64m",
        },
      },
    });

    await container.start();
    const { exitCode } = await waitForCompletion(container, options.timeout);
    const logs = await container.logs({
      follow: false,
      stdout: true,
      stderr: true,
    });
    const [stdout, stderr] = splitLogs(Buffer.from(logs));
    const stats = await container.stats({ stream: false });
    const duration = (Date.now() - startedAt) / 1000;

    return {
      success: exitCode === 0,
      exitCode,
      stdout,
      stderr,
      duration,
      resourceUsage: extractResourceUsage(stats),
      error:
        exitCode === 0
          ? undefined
          : stderr.trim() || `Container exited with code ${exitCode}`,
    };
  } catch (error) {
    const duration = (Date.now() - startedAt) / 1000;
    const message = error instanceof Error ? error.message : String(error);

    return {
      success: false,
      exitCode: -1,
      stdout: "",
      stderr: message,
      duration,
      resourceUsage: {
        cpuTime: 0,
        memoryPeak: "unknown",
        diskUsed: "unknown",
      },
      error: message,
    };
  } finally {
    if (container) {
      try {
        await container.remove({ force: true });
      } catch (error) {
        const dockerError = error as DockerError;
        if (dockerError.statusCode !== 404) {
          console.warn(
            `Failed to remove Docker container: ${dockerError.message}`,
          );
        }
      }
    }
  }
}

function dockerCommand(command: string): string {
  return command.toLowerCase() === process.execPath.toLowerCase()
    ? "node"
    : path.basename(command);
}

async function ensureImage(docker: Docker, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch (error) {
    const dockerError = error as DockerError;
    if (dockerError.statusCode !== 404) {
      throw error;
    }
  }

  const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    docker.pull(
      image,
      (error: Error | null, pullStream: NodeJS.ReadableStream) => {
        if (error) {
          reject(error);
        } else if (!pullStream) {
          reject(new Error(`Docker returned no pull stream for ${image}`));
        } else {
          resolve(pullStream);
        }
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function waitForCompletion(
  container: Docker.Container,
  timeout: number,
): Promise<{ exitCode: number }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(async () => {
      if (settled) {
        return;
      }

      try {
        await container.stop({ t: 1 });
      } catch (error) {
        const dockerError = error as DockerError;
        if (dockerError.statusCode !== 304) {
          settled = true;
          reject(
            new Error(
              `Execution timed out after ${timeout}s and the container could not be stopped: ${dockerError.message}`,
            ),
          );
          return;
        }
      }

      settled = true;
      reject(new Error(`Execution timed out after ${timeout}s`));
    }, timeout * 1000);

    container
      .wait()
      .then((data) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: data.StatusCode });
      })
      .catch((error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function splitLogs(output: Buffer): [string, string] {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  let framed = false;

  while (offset + 8 <= output.length) {
    const streamType = output[offset];
    const length = output.readUInt32BE(offset + 4);
    const frameEnd = offset + 8 + length;

    if ((streamType !== 1 && streamType !== 2) || frameEnd > output.length) {
      break;
    }

    framed = true;
    const content = output.subarray(offset + 8, frameEnd);
    (streamType === 2 ? stderr : stdout).push(content);
    offset = frameEnd;
  }

  if (!framed) {
    return [output.toString("utf8"), ""];
  }

  return [
    Buffer.concat(stdout).toString("utf8"),
    Buffer.concat(stderr).toString("utf8"),
  ];
}

function extractResourceUsage(
  stats: Docker.ContainerStats,
): ExecutionResult["resourceUsage"] {
  const memoryUsage = stats.memory_stats?.usage ?? 0;
  const cpuNanoseconds = stats.cpu_stats?.cpu_usage?.total_usage ?? 0;

  return {
    cpuTime: cpuNanoseconds / 1_000_000_000,
    memoryPeak: formatBytes(memoryUsage),
    diskUsed: "unknown",
  };
}

function parseMemory(limit: string): number {
  const match = limit.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]i?b?|b)?$/i);
  if (!match) {
    throw new Error(`Invalid Docker memory limit: ${limit}`);
  }

  const value = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    k: 1024,
    kb: 1024,
    kib: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
    tib: 1024 ** 4,
  };

  return Math.floor(value * multipliers[unit]);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(2)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)}MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
}
