import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedWikiConfig, WikiConfig } from "./types.js";

export const CONFIG_FILE = ".llmwiki-config.json";

export const DEFAULT_CONFIG: WikiConfig = {
  wikiPath: "wiki",
  sourcesPath: "sources",
  rawPath: "raw",
  autoCommit: false,
  search: {
    provider: "crossref",
    resultLimit: 5,
  },
};

function validateRelativePath(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Config ${key} must be a non-empty string`);
  if (path.isAbsolute(value))
    throw new Error(`Config ${key} must be relative to the repository root`);
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Config ${key} must stay inside the repository root`);
  }
  return normalized;
}

export function validateConfig(input: unknown): WikiConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Wiki config must be a JSON object");
  }
  const data = input as Record<string, unknown>;
  const search = data.search;
  if (!search || typeof search !== "object" || Array.isArray(search)) {
    throw new Error("Config search must be an object");
  }
  const searchData = search as Record<string, unknown>;
  if (searchData.provider !== "crossref")
    throw new Error('Config search.provider must be "crossref"');
  if (
    typeof searchData.resultLimit !== "number" ||
    !Number.isInteger(searchData.resultLimit) ||
    searchData.resultLimit < 1 ||
    searchData.resultLimit > 100
  ) {
    throw new Error(
      "Config search.resultLimit must be an integer from 1 to 100",
    );
  }
  if (typeof data.autoCommit !== "boolean")
    throw new Error("Config autoCommit must be a boolean");
  return {
    wikiPath: validateRelativePath(data.wikiPath, "wikiPath"),
    sourcesPath: validateRelativePath(data.sourcesPath, "sourcesPath"),
    rawPath: validateRelativePath(data.rawPath, "rawPath"),
    autoCommit: data.autoCommit,
    search: {
      provider: "crossref",
      resultLimit: searchData.resultLimit,
    },
  };
}

export async function loadConfig(
  root = process.cwd(),
): Promise<ResolvedWikiConfig> {
  const resolvedRoot = path.resolve(root);
  const configPath = path.join(resolvedRoot, CONFIG_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Wiki config not found: ${configPath}. Run "llmwiki init" first.`,
      );
    }
    if (error instanceof SyntaxError)
      throw new Error(`Malformed JSON in ${configPath}: ${error.message}`);
    throw error;
  }
  const config = validateConfig(parsed);
  return {
    ...config,
    root: resolvedRoot,
    configPath,
    wikiDir: path.resolve(resolvedRoot, config.wikiPath),
    sourcesDir: path.resolve(resolvedRoot, config.sourcesPath),
    rawDir: path.resolve(resolvedRoot, config.rawPath),
    metaDir: path.join(resolvedRoot, "meta"),
    schemaDir: path.join(resolvedRoot, "schema"),
  };
}
