import { access } from "node:fs/promises";
import path from "node:path";
import Docker from "dockerode";
import { loadConfig } from "../utils/config.js";
import { listApprovalRequests, listPendingApprovals } from "./approvals.js";
import { listRunRecords } from "./store.js";
import type { HealthCheck, HealthReport } from "./types.js";

export async function checkAgentHealth(
  root: string,
  options: { docker?: boolean } = {},
): Promise<HealthReport> {
  const checks: HealthCheck[] = [];
  try {
    const config = await loadConfig(root);
    checks.push({
      name: "config",
      status: "ok",
      message: "Agent configuration is valid",
    });
    if (config.wikiPath) {
      const wikiPath = path.resolve(root, config.wikiPath);
      try {
        await access(wikiPath);
        checks.push({
          name: "wiki",
          status: "ok",
          message: "Configured Wiki path is accessible",
        });
      } catch {
        checks.push({
          name: "wiki",
          status: "error",
          message: `Configured Wiki path is unavailable: ${wikiPath}`,
        });
      }
    }
    checks.push({
      name: "anthropic_credentials",
      status:
        process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
          ? "ok"
          : "warning",
      message:
        process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
          ? "Anthropic credentials are configured"
          : "Anthropic credentials are not configured; offline mode remains available",
    });
  } catch (error) {
    checks.push({
      name: "config",
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const [requests, experiments, runs] = await Promise.all([
    listApprovalRequests(root),
    listPendingApprovals(root),
    listRunRecords(root, 1),
  ]);
  const pendingApprovals = requests.length + experiments.length;
  checks.push({
    name: "approvals",
    status: pendingApprovals > 0 ? "warning" : "ok",
    message:
      pendingApprovals > 0
        ? `${pendingApprovals} approval request(s) are pending`
        : "No approval requests are pending",
  });
  checks.push({
    name: "last_run",
    status: runs[0]?.status === "failed" ? "warning" : "ok",
    message: runs[0]
      ? `Latest run ${runs[0].id} finished with status ${runs[0].status}`
      : "No continuous runs have been recorded",
  });

  if (options.docker) {
    try {
      await new Docker().ping();
      checks.push({
        name: "docker",
        status: "ok",
        message: "Docker daemon is reachable",
      });
    } catch (error) {
      checks.push({
        name: "docker",
        status: "error",
        message: `Docker daemon is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  return {
    status: checks.some((check) => check.status === "error")
      ? "unhealthy"
      : checks.some((check) => check.status === "warning")
        ? "degraded"
        : "healthy",
    checkedAt: new Date().toISOString(),
    root: path.resolve(root),
    checks,
  };
}
