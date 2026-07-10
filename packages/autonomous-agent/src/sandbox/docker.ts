
async function waitForCompletion(
  container: Docker.Container,
  timeout: number
): Promise<{ exitCode: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      container.stop().catch(() => {});
      reject(new Error(`Execution timeout after ${timeout}s`));
    }, timeout * 1000);

    container.wait((err: any, data: any) => {
      clearTimeout(timer);
      if (err) return reject(err);
      resolve({ exitCode: data.StatusCode });
    });
  });
}

function splitLogs(output: string): [string, string] {
  // Docker logs prefix each line with stream type
  // stdout: \x01\x00\x00\x00...
  // stderr: \x02\x00\x00\x00...
  const lines = output.split("\n");
  const stdout: string[] = [];
  const stderr: string[] = [];

  for (const line of lines) {
    if (!line) continue;
    const streamType = line.charCodeAt(0);
    const content = line.slice(8); // Skip 8-byte header

    if (streamType === 1) {
      stdout.push(content);
    } else if (streamType === 2) {
      stderr.push(content);
    } else {
      stdout.push(line); // Fallback for non-prefixed logs
    }
  }

  return [stdout.join("\n"), stderr.join("\n")];
}

function extractResourceUsage(stats: any): ExecutionResult["resourceUsage"] {
  const memoryUsage = stats.memory_stats?.usage || 0;
  const cpuDelta = stats.cpu_stats?.cpu_usage?.total_usage || 0;
  const systemDelta = stats.cpu_stats?.system_cpu_usage || 1;

  return {
    cpuTime: cpuDelta / systemDelta,
    memoryPeak: formatBytes(memoryUsage),
    diskUsed: "0", // Docker doesn't expose this easily
  };
}

function parseMemory(limit: string): number {
  const match = limit.match(/^(\d+)([kmg]?)$/i);
  if (!match) return 512 * 1024 * 1024; // Default 512MB

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "k":
      return value * 1024;
    case "m":
      return value * 1024 * 1024;
    case "g":
      return value * 1024 * 1024 * 1024;
    default:
      return value;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}
