/**
 * Sandbox execution types.
 */

export interface SandboxEnvironment {
  id: string;
  type: "docker" | "local";
  status: "created" | "running" | "stopped" | "failed";
  createdAt: string;
}

export interface ExecutionResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number; // seconds
  resourceUsage: {
    cpuTime: number;
    memoryPeak: string;
    diskUsed: string;
  };
  error?: string;
}

export interface ExecutionOptions {
  workDir: string;
  timeout: number;
  command: string;
  args: string[];
  env?: Record<string, string>;
}
