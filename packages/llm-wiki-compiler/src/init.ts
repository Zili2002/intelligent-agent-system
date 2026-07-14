import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  loadConfig,
  validateConfig,
} from "./config.js";
import type { ResolvedWikiConfig, WikiConfig } from "./types.js";
import { backfillRawManifest, initializeRawManifest } from "./manifest.js";
import { readTextIfExists, writeText } from "./utils.js";

const WIKI_SECTIONS = [
  "entities",
  "concepts",
  "ideas",
  "methods",
  "patterns",
  "tools",
];

export async function initWiki(
  root = process.cwd(),
  overrides: Partial<WikiConfig> = {},
): Promise<ResolvedWikiConfig> {
  const resolvedRoot = path.resolve(root);
  const configPath = path.join(resolvedRoot, CONFIG_FILE);
  const existing = await readTextIfExists(configPath);
  let config: WikiConfig;
  if (existing) {
    try {
      config = validateConfig(JSON.parse(existing));
    } catch (error) {
      throw new Error(
        `Cannot initialize with invalid existing config: ${(error as Error).message}`,
      );
    }
  } else {
    config = validateConfig({
      ...DEFAULT_CONFIG,
      ...overrides,
      search: { ...DEFAULT_CONFIG.search, ...(overrides.search ?? {}) },
    });
    await writeText(configPath, JSON.stringify(config, null, 2));
  }
  const resolved = await loadConfig(resolvedRoot);
  await Promise.all([
    mkdir(resolved.sourcesDir, { recursive: true }),
    mkdir(resolved.rawDir, { recursive: true }),
    mkdir(path.join(resolved.wikiDir, "sources"), { recursive: true }),
    mkdir(path.join(resolved.metaDir, "reflection"), { recursive: true }),
    mkdir(resolved.schemaDir, { recursive: true }),
    ...WIKI_SECTIONS.map((section) =>
      mkdir(path.join(resolved.wikiDir, section), { recursive: true }),
    ),
  ]);
  await writeText(
    path.join(resolved.schemaDir, "source-artifact.schema.json"),
    JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "LLMWiki processed source artifact",
        type: "object",
        required: [
          "version",
          "id",
          "hash",
          "title",
          "mediaType",
          "content",
          "provenance",
          "provenanceHistory",
          "ingestedAt",
        ],
      },
      null,
      2,
    ),
  );
  await writeText(
    path.join(resolved.schemaDir, "raw-manifest.schema.json"),
    JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "LLMWiki raw source reconstruction manifest",
        type: "object",
        required: ["version", "updatedAt", "entries"],
        properties: {
          version: { const: 1 },
          updatedAt: { type: "string" },
          entries: { type: "array" },
        },
      },
      null,
      2,
    ),
  );
  const initialFiles: Array<[string, string]> = [
    [
      path.join(resolved.wikiDir, "index.md"),
      "# Knowledge index\n\n_No sources ingested._\n",
    ],
    [
      path.join(resolved.wikiDir, "log.md"),
      "# Compilation log\n\n_No compiler operations recorded._\n",
    ],
    [
      path.join(resolved.metaDir, "gaps.md"),
      "# Knowledge gaps and learning plan\n\n_No gaps recorded._\n",
    ],
    [
      path.join(resolved.metaDir, "capability_map.md"),
      "# Capability map\n\n_No compiled knowledge yet._\n",
    ],
    [
      path.join(resolved.metaDir, "evolution_log.md"),
      "# Evolution log\n\n_No evolution operations recorded._\n",
    ],
  ];
  for (const [filePath, content] of initialFiles) {
    if ((await readTextIfExists(filePath)) === undefined) {
      await writeText(filePath, content);
    }
  }
  await initializeRawManifest(resolved);
  await backfillRawManifest(resolved);
  return resolved;
}
