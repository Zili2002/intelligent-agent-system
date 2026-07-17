import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function atomicWriteText(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      content.endsWith("\n") ? content : `${content}\n`,
      "utf8",
    );
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const content = JSON.stringify(value, null, 2);
  if (content === undefined) {
    throw new Error("Atomic JSON value must be JSON-serializable");
  }
  await atomicWriteText(filePath, content);
}

export async function readJsonIfExists<T>(
  filePath: string,
  parse: (value: unknown) => T,
): Promise<T | undefined> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${filePath}: ${message}`, {
      cause: error,
    });
  }
  return parse(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
