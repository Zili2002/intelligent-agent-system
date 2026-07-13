import { spawn } from "node:child_process";
import path from "node:path";
import { loadConfig } from "./config.js";

function runGit(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", root, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(
            `git ${args[0]} failed (${code}): ${stderr.trim() || stdout.trim()}`,
          ),
        );
    });
  });
}

export async function autoCommitIfEnabled(
  root = process.cwd(),
  message = "Update compiled wiki",
): Promise<boolean> {
  const config = await loadConfig(root);
  if (!config.autoCommit) return false;
  const paths = [
    path.relative(config.root, config.configPath),
    config.wikiPath,
    config.sourcesPath,
    config.rawPath,
    "meta",
    "schema",
  ].map((entry) => entry.split(path.sep).join("/"));
  const status = await runGit(config.root, [
    "status",
    "--porcelain",
    "--",
    ...paths,
  ]);
  if (!status) return false;
  await runGit(config.root, ["add", "--", ...paths]);
  await runGit(config.root, ["commit", "-m", message]);
  return true;
}
