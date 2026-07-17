import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "./file-lock.js";
import { sanitizeJson } from "./redaction.js";

export async function appendJsonLine(
  filePath: string,
  value: unknown,
  options: { redact?: boolean } = {},
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const stored = options.redact === false ? value : sanitizeJson(value);
  await withFileLock(
    `${filePath}.lock`,
    () => appendFile(filePath, `${JSON.stringify(stored)}\n`, "utf8"),
    { waitTimeoutMs: 5_000, retryDelayMs: 5 },
  );
}

export async function readJsonLines<T>(
  filePath: string,
  parse: (value: unknown, line: number) => T,
  options: { limit?: number } = {},
): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1)
  ) {
    throw new Error("JSONL limit must be a positive integer");
  }
  const lines = content.split(/\r?\n/).filter(Boolean);
  const selected =
    options.limit === undefined ? lines : lines.slice(-options.limit);
  const firstLine = lines.length - selected.length + 1;
  return selected.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      const lineNumber = firstLine + index;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to parse ${filePath} line ${lineNumber}: ${message}`,
        { cause: error },
      );
    }
    return parse(value, firstLine + index);
  });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
