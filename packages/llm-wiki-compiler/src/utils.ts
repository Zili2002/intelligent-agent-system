import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const GENERATED_START = "<!-- llmwiki:generated:start -->";
export const GENERATED_END = "<!-- llmwiki:generated:end -->";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "untitled";
}

export function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToText(html: string): string {
  return normalizeText(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'"),
  );
}

export function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

export function generatedDocument(
  frontmatter: Record<string, string | string[]>,
  body: string,
  existing?: string,
): string {
  const yaml = Object.entries(frontmatter)
    .map(([key, value]) =>
      Array.isArray(value)
        ? `${key}:\n${value.map((item) => `  - ${quoteYaml(item)}`).join("\n")}`
        : `${key}: ${quoteYaml(value)}`,
    )
    .join("\n");
  let userContent = "";
  if (existing) {
    const end = existing.indexOf(GENERATED_END);
    if (end >= 0)
      userContent = existing.slice(end + GENERATED_END.length).trim();
  }
  return `---\n${yaml}\n---\n\n${GENERATED_START}\n${body.trim()}\n${GENERATED_END}${
    userContent ? `\n\n${userContent}` : "\n"
  }`;
}

export async function writeText(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    temporary,
    content.endsWith("\n") ? content : `${content}\n`,
    "utf8",
  );
  await rename(temporary, filePath);
}

export async function readTextIfExists(
  filePath: string,
): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer");
  }
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failure: unknown;
  const worker = async () => {
    while (failure === undefined) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index]!, index);
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(1, items.length)) },
      worker,
    ),
  );
  if (failure !== undefined) throw failure;
  return results;
}

export async function walkFiles(
  directory: string,
  extension?: string,
): Promise<string[]> {
  const result: string[] = [];
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory())
        result.push(...(await walkFiles(fullPath, extension)));
      else if (entry.isFile() && (!extension || entry.name.endsWith(extension)))
        result.push(fullPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result.sort();
}

export async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export function relativePosix(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

export function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
