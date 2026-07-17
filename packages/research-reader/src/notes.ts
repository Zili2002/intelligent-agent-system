import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText, withFileLock } from "@intelligent-agent/shared";
import { loadPaperPassport, mutatePaperPassport } from "./store.js";
import type { ResolvedReaderConfig } from "./types.js";

export async function appendPaperNote(
  config: ResolvedReaderConfig,
  paperId: string,
  content: string,
  now = new Date(),
): Promise<string> {
  if (!content.trim()) throw new Error("Paper note must not be empty");
  const paper = await loadPaperPassport(config, paperId);
  if (!paper) throw new Error(`Paper not found: ${paperId}`);
  const notePath = path.join(config.notesDir, `${paper.id}.md`);
  await withFileLock(`${notePath}.lock`, async () => {
    const existing = await readTextIfExists(notePath);
    const header = existing
      ? existing.trimEnd()
      : `# Notes: ${paper.metadata.title}\n\nPaper ID: \`${paper.id}\``;
    const entry = `## ${now.toISOString()}\n\n${content.trim()}`;
    await atomicWriteText(notePath, `${header}\n\n${entry}\n`);
  });
  await mutatePaperPassport(config, paperId, (current) => {
    if (!current) throw new Error(`Paper not found: ${paperId}`);
    current.reading.notePath = relativePosix(config.root, notePath);
    current.updatedAt = now.toISOString();
    return current;
  });
  return notePath;
}

export async function readPaperNote(
  config: ResolvedReaderConfig,
  paperId: string,
): Promise<string | undefined> {
  const paper = await loadPaperPassport(config, paperId);
  if (!paper) throw new Error(`Paper not found: ${paperId}`);
  return readTextIfExists(path.join(config.notesDir, `${paper.id}.md`));
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function relativePosix(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}
