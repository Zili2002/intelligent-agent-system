import path from "node:path";
import { loadConfig } from "./config.js";
import type { ServiceOptions } from "./types.js";
import { walkFiles } from "./utils.js";

export interface WikiStatus {
  root: string;
  sourceArtifacts: number;
  wikiPages: number;
  reflections: number;
  autoCommit: boolean;
}

export async function getStatus(
  options: ServiceOptions = {},
): Promise<WikiStatus> {
  const config = await loadConfig(options.root);
  const [sources, pages, reflections] = await Promise.all([
    walkFiles(config.sourcesDir, ".json"),
    walkFiles(config.wikiDir, ".md"),
    walkFiles(path.join(config.metaDir, "reflection"), ".md"),
  ]);
  return {
    root: config.root,
    sourceArtifacts: sources.length,
    wikiPages: pages.length,
    reflections: reflections.filter(
      (file) => path.basename(file).toLowerCase() !== "readme.md",
    ).length,
    autoCommit: config.autoCommit,
  };
}
