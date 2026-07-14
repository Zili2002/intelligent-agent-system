#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { autoCommitIfEnabled } from "./git.js";
import { initWiki } from "./init.js";
import { WikiCompiler } from "./service.js";

const program = new Command();

function root(): string {
  return program.opts<{ root: string }>().root;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function commit(message: string): Promise<void> {
  const committed = await autoCommitIfEnabled(root(), message);
  if (committed)
    process.stderr.write(
      "Created an opt-in local git commit. Nothing was pushed.\n",
    );
}

function positiveInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Expected an integer from 1 to 100");
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new InvalidArgumentError("Expected an integer from 1 to 100");
  }
  return parsed;
}

program
  .name("llmwiki")
  .description("Deterministic, evidence-first local wiki compiler")
  .version("0.3.0")
  .option("-r, --root <path>", "repository root", process.cwd());

program
  .command("init")
  .description("initialize configuration and wiki directories")
  .action(async () => {
    output(await initWiki(root()));
    await commit("Initialize llmwiki");
  });

program
  .command("ingest")
  .description("ingest a local file or HTTP(S) URL")
  .argument("<input>", "file path or URL")
  .option("--storage-uri <uri>", "External URI used to reconstruct raw content")
  .option("--file-name <name>", "Preferred restored raw filename")
  .action(
    async (
      input: string,
      commandOptions: { storageUri?: string; fileName?: string },
    ) => {
      output(
        await new WikiCompiler({ root: root() }).ingest(input, commandOptions),
      );
      await commit("Ingest wiki source");
    },
  );

program
  .command("manifest")
  .description("show raw reconstruction manifest status")
  .option("--full", "output the complete manifest")
  .action(async (commandOptions: { full?: boolean }) => {
    const compiler = new WikiCompiler({ root: root() });
    output(
      commandOptions.full
        ? await compiler.manifest()
        : await compiler.manifestStatus(),
    );
  });

program
  .command("restore-raw")
  .description("restore raw files from manifest URLs or storage URIs")
  .option("--force", "replace an existing file after verifying the source")
  .option(
    "--max-mb <number>",
    "maximum restored file size in MB",
    positiveInteger,
    100,
  )
  .action(async (commandOptions: { force?: boolean; maxMb: number }) => {
    const result = await new WikiCompiler({ root: root() }).restoreRaw({
      ...(commandOptions.force ? { force: true } : {}),
      maxFileBytes: commandOptions.maxMb * 1024 * 1024,
    });
    output(result);
    if (result.restored > 0) {
      await commit("Restore raw wiki sources");
    }
    if (result.errors > 0) process.exitCode = 1;
  });

program
  .command("compile")
  .description("compile processed sources into wiki pages and graph artifacts")
  .action(async () => {
    output(await new WikiCompiler({ root: root() }).compile());
    await commit("Compile wiki");
  });

program
  .command("query")
  .description("answer with lexical evidence and citations")
  .argument("<question>", "question to search for")
  .option("-n, --limit <number>", "maximum cited matches", positiveInteger, 5)
  .action(async (question: string, commandOptions: { limit: number }) => {
    output(
      await new WikiCompiler({ root: root() }).query(
        question,
        commandOptions.limit,
      ),
    );
  });

program
  .command("lint")
  .description("check wiki integrity and generated provenance")
  .action(async () => {
    const result = await new WikiCompiler({ root: root() }).lint();
    output(result);
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("status")
  .description("show source, page, reflection, and auto-commit status")
  .action(async () =>
    output(await new WikiCompiler({ root: root() }).status()),
  );

program
  .command("search")
  .description("search Crossref or an injected provider")
  .argument("<query>", "search query")
  .option("-n, --limit <number>", "maximum results", positiveInteger)
  .option("--import", "ingest evidence-bearing result metadata", false)
  .action(
    async (
      query: string,
      commandOptions: { limit?: number; import: boolean },
    ) => {
      const result = await new WikiCompiler({ root: root() }).search(query, {
        ...(commandOptions.limit ? { limit: commandOptions.limit } : {}),
        importResults: commandOptions.import,
      });
      output(result);
      if (result.errors.length > 0 && result.results.length === 0) {
        process.exitCode = 1;
      }
      if (commandOptions.import) await commit("Import wiki search evidence");
    },
  );

program
  .command("reflect")
  .description("write a transparent heuristic coverage reflection and gap plan")
  .action(async () => {
    output(await new WikiCompiler({ root: root() }).reflect());
    await commit("Reflect on wiki coverage");
  });

program
  .command("learn")
  .description("search selected generated gaps, ingest evidence, and recompile")
  .option("-g, --gaps <number>", "maximum gaps to search", positiveInteger, 3)
  .option("-n, --limit <number>", "results per gap", positiveInteger)
  .action(async (commandOptions: { gaps: number; limit?: number }) => {
    const result = await new WikiCompiler({ root: root() }).learn({
      gapLimit: commandOptions.gaps,
      ...(commandOptions.limit ? { limit: commandOptions.limit } : {}),
    });
    output(result);
    if (
      result.selectedGaps.length > 0 &&
      result.imported === 0 &&
      result.searches.every(
        (search) => search.results.length === 0 && search.errors.length > 0,
      )
    ) {
      process.exitCode = 1;
    }
    await commit("Learn from wiki gaps");
  });

await program.parseAsync().catch((error: unknown) => {
  process.stderr.write(
    `llmwiki: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
