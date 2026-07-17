#!/usr/bin/env node

import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { createReaderWebServer } from "./server.js";

const program = new Command();

program
  .name("research-reader-web")
  .description("Start the localhost-only Research Reader Web UI")
  .requiredOption("--root <path>", "Research Wiki root")
  .option(
    "--port <number>",
    "Local port; 0 selects an available port",
    port,
    4173,
  )
  .option("--approve-llm", "Approve LLM Q&A for this server process")
  .option("--max-llm-tokens <number>", "Bound each Q&A operation", positiveInt)
  .action(
    async (options: {
      root: string;
      port: number;
      approveLlm?: boolean;
      maxLlmTokens?: number;
    }) => {
      const web = createReaderWebServer({
        root: path.resolve(options.root),
        port: options.port,
        ...(options.approveLlm ? { approveLlm: true } : {}),
        ...(options.maxLlmTokens === undefined
          ? {}
          : { maxLlmTokens: options.maxLlmTokens }),
      });
      const address = await web.start();
      process.stdout.write(`Research Reader Web: ${address.url}\n`);
      const stop = async () => {
        await web.stop();
        process.exitCode = 0;
      };
      process.once("SIGINT", () => void stop());
      process.once("SIGTERM", () => void stop());
    },
  );

await program.parseAsync(process.argv);

function port(value: string): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0 || result > 65_535) {
    throw new InvalidArgumentError("Port must be from 0 to 65535");
  }
  return result;
}

function positiveInt(value: string): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) {
    throw new InvalidArgumentError("Value must be a positive integer");
  }
  return result;
}
