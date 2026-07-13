import { readFile } from "node:fs/promises";
import path from "node:path";
import { compileWiki } from "./compile.js";
import { loadConfig } from "./config.js";
import { searchWiki } from "./search.js";
import type { LearnResult, SearchOptions, ServiceOptions } from "./types.js";
import { readTextIfExists, writeText } from "./utils.js";

function parseGaps(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1])
    .filter((line): line is string => Boolean(line))
    .filter(
      (line) =>
        !/^No (?:thin concepts?|thin|heuristic) (?:gaps? )?detected/i.test(
          line,
        ),
    );
}

export async function learnWiki(
  options: SearchOptions & ServiceOptions & { gapLimit?: number } = {},
): Promise<LearnResult> {
  const config = await loadConfig(options.root);
  const gapsPath = path.join(config.metaDir, "gaps.md");
  let gapContent: string;
  try {
    gapContent = await readFile(gapsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No generated gaps file found: ${gapsPath}. Run compile or reflect first.`,
      );
    }
    throw error;
  }
  const gapLimit = options.gapLimit ?? 3;
  if (!Number.isInteger(gapLimit) || gapLimit < 1)
    throw new Error("Gap limit must be a positive integer");
  const selectedGaps = parseGaps(gapContent).slice(0, gapLimit);
  const searches = [];
  for (const gap of selectedGaps) {
    searches.push(
      await searchWiki(gap, {
        ...options,
        root: config.root,
        importResults: true,
      }),
    );
  }
  const imported = searches.reduce(
    (count, run) => count + run.imported.length,
    0,
  );
  let compiled = false;
  if (imported > 0) {
    await compileWiki({
      root: config.root,
      ...(options.now ? { now: options.now } : {}),
    });
    compiled = true;
  }
  const now = (options.now ?? (() => new Date()))().toISOString();
  const logPath = path.join(config.metaDir, "learning-log.md");
  const existing = (await readTextIfExists(logPath)) ?? "# Learning log\n";
  const details = searches
    .flatMap((run) => [
      `  - ${run.query}: provider=${run.provider}, returned=${run.results.length}, imported=${run.imported.length}, errors=${run.errors.length}`,
      ...run.errors.map((error) => `    - Error: ${error}`),
    ])
    .join("\n");
  await writeText(
    logPath,
    `${existing.trimEnd()}

- ${now}: selected=${selectedGaps.length}, imported=${imported}, recompiled=${compiled}
${details || "  - No eligible gaps were selected."}`,
  );
  const evolutionPath = path.join(config.metaDir, "evolution_log.md");
  const evolution =
    (await readTextIfExists(evolutionPath)) ?? "# Evolution log\n";
  await writeText(
    evolutionPath,
    `${evolution.trimEnd()}

- ${now}: learning selected=${selectedGaps.length}, imported=${imported}, recompiled=${compiled}`,
  );
  return { selectedGaps, searches, imported, compiled, logPath };
}
