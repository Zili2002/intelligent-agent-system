#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { autoCommitIfEnabled } from "./git.js";
import { initWiki } from "./init.js";
import { WikiCompiler } from "./service.js";

const program = new Command();

function root(): string {
  return program.opts<{ root: string }>().root;
}
function serviceOptions(): {
  root: string;
  approveLlm: boolean;
  maxLlmTokens: number;
} {
  const options = program.opts<{
    root: string;
    approveLlm: boolean;
    maxLlmTokens: number;
  }>();
  return {
    root: options.root,
    approveLlm: options.approveLlm,
    maxLlmTokens: options.maxLlmTokens,
  };
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

function positiveTokenInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Expected a positive token limit");
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Expected a positive token limit");
  }
  return parsed;
}

function enrichmentLimit(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new InvalidArgumentError("Expected a positive integer");
  }
  return Number(value);
}

function providerList(value: string): string[] {
  const providers = value
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean);
  if (
    !providers.length ||
    providers.some(
      (provider) => !["crossref", "arxiv", "openalex"].includes(provider),
    )
  ) {
    throw new InvalidArgumentError(
      "Providers must be a comma-separated list of arxiv, openalex, or crossref",
    );
  }

  return [...new Set(providers)];
}

function claimList(value: string): string[] {
  const claims = value
    .split(",")
    .map((claim) => claim.trim())
    .filter(Boolean);
  if (!claims.length) {
    throw new InvalidArgumentError("Expected comma-separated Claim IDs");
  }
  return [...new Set(claims)];
}

function publicationDate(value: string): string {
  const match = value.match(/^(\d{4})(?:-(\d{2})-(\d{2}))?$/);
  if (!match) {
    throw new InvalidArgumentError(
      "Expected a date in YYYY or YYYY-MM-DD format",
    );
  }
  if (match[2] !== undefined) {
    const date = new Date(
      Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
    );
    if (
      date.getUTCFullYear() !== Number(match[1]) ||
      date.getUTCMonth() !== Number(match[2]) - 1 ||
      date.getUTCDate() !== Number(match[3])
    ) {
      throw new InvalidArgumentError(
        "Expected a valid YYYY or YYYY-MM-DD date",
      );
    }
  }
  return value;
}

function fullTextFailure(value: string): "metadata" | "skip" {
  if (value !== "metadata" && value !== "skip") {
    throw new InvalidArgumentError(
      'Expected full-text failure mode "metadata" or "skip"',
    );
  }
  return value;
}

program
  .name("llmwiki")
  .description("LLM evidence-first local wiki compiler")
  .version("1.4.1")
  .option("-r, --root <path>", "repository root", process.cwd())
  .option(
    "--approve-llm",
    "explicitly permit billable Anthropic knowledge calls",
    false,
  )
  .option(
    "--max-llm-tokens <number>",
    "maximum estimated and actual tokens for one semantic operation",
    positiveTokenInteger,
    10_000,
  );

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
  .option(
    "--on-full-text-failure <mode>",
    "metadata or skip",
    fullTextFailure,
    "metadata",
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
    output(await new WikiCompiler(serviceOptions()).compile());
    await commit("Compile wiki");
  });

program
  .command("index")
  .description("build or incrementally update the local Claim vector index")
  .option("--force", "re-embed every Claim", false)
  .action(async (commandOptions: { force: boolean }) => {
    output(
      await new WikiCompiler({ root: root() }).indexSemantic(
        commandOptions.force,
      ),
    );
    await commit("Index wiki Claims");
  });

program
  .command("benchmark-retrieval")
  .description("create a fixed semantic retrieval benchmark")
  .option("--force", "replace the existing fixed benchmark", false)
  .action(async (commandOptions: { force: boolean }) => {
    output(
      await new WikiCompiler(serviceOptions()).benchmarkRetrieval(
        commandOptions.force,
      ),
    );
    await commit("Create retrieval benchmark");
  });

program
  .command("evaluate-retrieval")
  .description("measure retrieval, citation, refusal, latency, and conflicts")
  .option("--no-answer", "evaluate retrieval without paid answer calls")
  .action(async (commandOptions: { answer: boolean }) => {
    output(
      await new WikiCompiler(serviceOptions()).evaluateRetrieval(
        commandOptions.answer,
      ),
    );
    await commit("Evaluate wiki retrieval");
  });

program
  .command("query")
  .description("answer from compiled evidence with validated citations")
  .argument("<question>", "question to search for")
  .option("-n, --limit <number>", "maximum cited matches", positiveInteger, 5)
  .action(async (question: string, commandOptions: { limit: number }) => {
    output(
      await new WikiCompiler(serviceOptions()).query(
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
  .command("frontier")
  .description("show and prune the bounded Evidence Frontier")
  .action(async () =>
    output(await new WikiCompiler({ root: root() }).frontierStatus()),
  );

program
  .command("frontier-run")
  .description("process one bounded Evidence Frontier cycle")
  .option(
    "-c, --clues <number>",
    "maximum clues selected this cycle",
    positiveInteger,
    10,
  )
  .option("-n, --limit <number>", "results per clue", positiveInteger, 3)
  .option(
    "--providers <names>",
    "comma-separated providers: arxiv,openalex,crossref",
    providerList,
  )
  .option("--full-text", "acquire approved open full text", false)
  .option("--no-oa-only", "allow explicitly licensed non-OA full text")
  .option(
    "--max-downloads <number>",
    "maximum full-text attempts across the cycle",
    positiveInteger,
    3,
  )
  .option(
    "--max-mb <number>",
    "maximum full-text file size in MB",
    positiveInteger,
    100,
  )
  .option(
    "--on-full-text-failure <mode>",
    "metadata or skip",
    fullTextFailure,
    "metadata",
  )
  .action(
    async (commandOptions: {
      clues: number;
      limit: number;
      providers?: string[];
      fullText: boolean;
      oaOnly: boolean;
      maxDownloads: number;
      maxMb: number;
      onFullTextFailure: "metadata" | "skip";
    }) => {
      output(
        await new WikiCompiler(serviceOptions()).runFrontier({
          clueLimit: commandOptions.clues,
          limit: commandOptions.limit,
          ...(commandOptions.providers
            ? {
                providers: commandOptions.providers as (
                  | "crossref"
                  | "arxiv"
                  | "openalex"
                )[],
              }
            : {}),
          fullText: commandOptions.fullText,
          oaOnly: commandOptions.oaOnly,
          maxDownloads: commandOptions.maxDownloads,
          maxFileBytes: commandOptions.maxMb * 1024 * 1024,
          onFullTextFailure: commandOptions.onFullTextFailure,
        }),
      );
      await commit("Process evidence frontier");
    },
  );

program
  .command("refresh")
  .description("refresh source metadata and incrementally propagate changes")
  .option("--force", "ignore the configured refresh interval", false)
  .option("--no-recompute", "record changes without cached recomputation")
  .option("--limit <number>", "maximum sources to refresh", enrichmentLimit)
  .action(
    async (commandOptions: {
      force: boolean;
      recompute: boolean;
      limit?: number;
    }) => {
      const result = await new WikiCompiler({
        root: root(),
      }).refresh({
        force: commandOptions.force,
        recompute: commandOptions.recompute,
        ...(commandOptions.limit ? { limit: commandOptions.limit } : {}),
      });
      output(result);
      if (result.metadataChanged) await commit("Refresh wiki knowledge");
    },
  );

program
  .command("search")
  .description("search configured literature providers")
  .argument("<query>", "search query")
  .option("-n, --limit <number>", "maximum results", positiveInteger)
  .option("--import", "ingest evidence-bearing result metadata", false)
  .option(
    "--providers <names>",
    "comma-separated providers: arxiv,openalex,crossref",
    providerList,
  )
  .option(
    "--from <date>",
    "minimum publication date (YYYY or YYYY-MM-DD)",
    publicationDate,
  )
  .option(
    "--to <date>",
    "maximum publication date (YYYY or YYYY-MM-DD)",
    publicationDate,
  )
  .option(
    "--full-text",
    "acquire approved open full text after screening",
    false,
  )
  .option("--no-oa-only", "allow non-open-access full text")
  .option(
    "--max-downloads <number>",
    "maximum full-text downloads",
    positiveInteger,
    3,
  )
  .option(
    "--max-mb <number>",
    "maximum full-text file size in MB",
    positiveInteger,
    100,
  )
  .action(
    async (
      query: string,
      commandOptions: {
        limit?: number;
        import: boolean;
        providers?: string[];
        from?: string;
        to?: string;
        fullText: boolean;
        oaOnly: boolean;
        maxDownloads: number;
        maxMb: number;
        onFullTextFailure: "metadata" | "skip";
      },
    ) => {
      const importResults = commandOptions.import || commandOptions.fullText;
      const result = await new WikiCompiler(serviceOptions()).search(query, {
        ...(commandOptions.limit ? { limit: commandOptions.limit } : {}),
        ...(commandOptions.providers
          ? {
              providers: commandOptions.providers as (
                | "crossref"
                | "arxiv"
                | "openalex"
              )[],
            }
          : {}),
        ...(commandOptions.from ? { from: commandOptions.from } : {}),
        ...(commandOptions.to ? { to: commandOptions.to } : {}),
        importResults,
        fullText: commandOptions.fullText,
        oaOnly: commandOptions.oaOnly,
        maxDownloads: commandOptions.maxDownloads,
        maxFileBytes: commandOptions.maxMb * 1024 * 1024,
        onFullTextFailure: commandOptions.onFullTextFailure,
      });
      output(result);
      if (result.errors.length > 0 && result.results.length === 0) {
        process.exitCode = 1;
      }
      if (importResults) await commit("Import wiki search evidence");
    },
  );

program
  .command("enrich-openalex")
  .description(
    "enrich processed source metadata from OpenAlex without changing evidence text",
  )
  .option("--limit <number>", "maximum processed sources", enrichmentLimit)
  .option("--dry-run", "report deterministic matches without writing", false)
  .option(
    "--only-missing",
    "skip sources already containing OpenAlex ID, citations, type, and retraction status",
    false,
  )
  .action(
    async (commandOptions: {
      limit?: number;
      dryRun: boolean;
      onlyMissing: boolean;
    }) => {
      const result = await new WikiCompiler({ root: root() }).enrichOpenAlex({
        ...(commandOptions.limit ? { limit: commandOptions.limit } : {}),
        dryRun: commandOptions.dryRun,
        onlyMissing: commandOptions.onlyMissing,
      });
      output(result);
      if (result.enriched > 0 && !commandOptions.dryRun) {
        await commit("Enrich wiki source metadata from OpenAlex");
      }
      if (result.failed > 0) process.exitCode = 1;
    },
  );

program
  .command("reflect")
  .description(
    "write an LLM evidence-grounded coverage reflection and gap plan",
  )
  .action(async () => {
    output(await new WikiCompiler(serviceOptions()).reflect());
    await commit("Reflect on wiki coverage");
  });

program
  .command("adjudicate")
  .description("adjudicate compiled contradictions from immutable evidence")
  .action(async () => {
    output(await new WikiCompiler(serviceOptions()).adjudicate());
    await commit("Adjudicate wiki contradictions");
  });

program
  .command("corroborate")
  .description(
    "target weak Claims, collect independent evidence, compile, and adjudicate",
  )
  .option("-c, --claims <ids>", "comma-separated explicit Claim IDs", claimList)
  .option(
    "-n, --claim-limit <number>",
    "maximum automatically selected Claims",
    positiveInteger,
    3,
  )
  .option(
    "--all-claims",
    "select from the complete Registry instead of summary",
  )
  .option(
    "--providers <names>",
    "comma-separated providers: arxiv,openalex,crossref",
    providerList,
  )
  .option("--result-limit <number>", "results per search", positiveInteger, 3)
  .option("--from <date>", "minimum publication date", publicationDate)
  .option("--to <date>", "maximum publication date", publicationDate)
  .option("--full-text", "acquire approved open full text", false)
  .option("--no-oa-only", "allow explicitly licensed non-OA full text")
  .option(
    "--max-downloads <number>",
    "maximum full-text attempts across the run",
    positiveInteger,
    6,
  )
  .option(
    "--max-mb <number>",
    "maximum full-text file size in MB",
    positiveInteger,
    100,
  )
  .option(
    "--on-full-text-failure <mode>",
    "metadata or skip",
    fullTextFailure,
    "metadata",
  )
  .option("--no-adjudicate", "skip contradiction adjudication after compile")
  .action(
    async (commandOptions: {
      claims?: string[];
      claimLimit: number;
      allClaims?: boolean;
      providers?: string[];
      resultLimit: number;
      from?: string;
      to?: string;
      fullText: boolean;
      oaOnly: boolean;
      maxDownloads: number;
      maxMb: number;
      onFullTextFailure: "metadata" | "skip";
      adjudicate: boolean;
    }) => {
      const result = await new WikiCompiler(serviceOptions()).corroborate({
        ...(commandOptions.claims ? { claimIds: commandOptions.claims } : {}),
        claimLimit: commandOptions.claimLimit,
        summaryOnly: !commandOptions.allClaims,
        ...(commandOptions.providers
          ? {
              providers: commandOptions.providers as (
                | "crossref"
                | "arxiv"
                | "openalex"
              )[],
            }
          : {}),
        limit: commandOptions.resultLimit,
        ...(commandOptions.from ? { from: commandOptions.from } : {}),
        ...(commandOptions.to ? { to: commandOptions.to } : {}),
        fullText: commandOptions.fullText,
        oaOnly: commandOptions.oaOnly,
        maxDownloads: commandOptions.maxDownloads,
        maxFileBytes: commandOptions.maxMb * 1024 * 1024,
        onFullTextFailure: commandOptions.onFullTextFailure,
        adjudicate: commandOptions.adjudicate,
      });
      output(result);
      await commit("Corroborate wiki Claims");
    },
  );

program
  .command("learn")
  .description("search selected generated gaps, ingest evidence, and recompile")
  .option("-g, --gaps <number>", "maximum gaps to search", positiveInteger, 3)
  .option("-n, --limit <number>", "results per gap", positiveInteger)
  .option(
    "--providers <names>",
    "comma-separated providers: arxiv,openalex,crossref",
    providerList,
  )
  .option(
    "--from <date>",
    "minimum publication date (YYYY or YYYY-MM-DD)",
    publicationDate,
  )
  .option(
    "--to <date>",
    "maximum publication date (YYYY or YYYY-MM-DD)",
    publicationDate,
  )
  .option("--full-text", "acquire approved open full text", false)
  .option("--no-oa-only", "allow explicitly licensed non-OA full text")
  .option(
    "--max-downloads <number>",
    "maximum full-text downloads across the learn run",
    positiveInteger,
    3,
  )
  .option(
    "--max-mb <number>",
    "maximum full-text file size in MB",
    positiveInteger,
    100,
  )
  .option(
    "--on-full-text-failure <mode>",
    "metadata or skip",
    fullTextFailure,
    "metadata",
  )
  .action(
    async (commandOptions: {
      gaps: number;
      limit?: number;
      providers?: string[];
      from?: string;
      to?: string;
      fullText: boolean;
      oaOnly: boolean;
      maxDownloads: number;
      maxMb: number;
      onFullTextFailure: "metadata" | "skip";
    }) => {
      const result = await new WikiCompiler(serviceOptions()).learn({
        gapLimit: commandOptions.gaps,
        ...(commandOptions.limit ? { limit: commandOptions.limit } : {}),
        ...(commandOptions.providers
          ? {
              providers: commandOptions.providers as (
                | "crossref"
                | "arxiv"
                | "openalex"
              )[],
            }
          : {}),
        ...(commandOptions.from ? { from: commandOptions.from } : {}),
        ...(commandOptions.to ? { to: commandOptions.to } : {}),
        fullText: commandOptions.fullText,
        oaOnly: commandOptions.oaOnly,
        maxDownloads: commandOptions.maxDownloads,
        maxFileBytes: commandOptions.maxMb * 1024 * 1024,
        onFullTextFailure: commandOptions.onFullTextFailure,
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
    },
  );

await program.parseAsync().catch((error: unknown) => {
  process.stderr.write(
    `llmwiki: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
