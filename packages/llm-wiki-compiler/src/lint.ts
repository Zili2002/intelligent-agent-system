import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { loadRawManifest, safeRawTarget } from "./manifest.js";
import type { LintIssue, LintResult, ServiceOptions } from "./types.js";
import {
  GENERATED_END,
  GENERATED_START,
  isFile,
  relativePosix,
  walkFiles,
} from "./utils.js";

function issue(
  target: LintIssue[],
  severity: LintIssue["severity"],
  code: string,
  filePath: string,
  root: string,
  message: string,
): void {
  target.push({ severity, code, path: relativePosix(root, filePath), message });
}

function frontmatterValue(content: string, key: string): string | undefined {
  const block = content.match(/^---\n([\s\S]*?)\n---/)?.[1];
  return block
    ?.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]
    ?.replace(/^"|"$/g, "");
}

function frontmatterList(content: string, key: string): string[] {
  const block = content.match(/^---\n([\s\S]*?)\n---/)?.[1];
  const listBlock = block?.match(
    new RegExp(`^${key}:\\n((?: {2}- .+(?:\\n|$))+)`, "m"),
  )?.[1];
  if (!listBlock) return [];
  return listBlock
    .split("\n")
    .map((line) => line.match(/^ {2}- (.+)$/)?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => {
      try {
        return JSON.parse(value) as string;
      } catch {
        return value.replace(/^"|"$/g, "");
      }
    });
}

export async function lintWiki(
  options: ServiceOptions = {},
): Promise<LintResult> {
  const config = await loadConfig(options.root);
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];
  const slugFiles = new Map<string, string[]>();
  const markdownFiles = await walkFiles(config.wikiDir, ".md");
  const sourceFiles = await walkFiles(config.sourcesDir, ".json");

  for (const file of markdownFiles) {
    const content = await readFile(file, "utf8");
    const generated =
      content.includes(GENERATED_START) ||
      frontmatterValue(content, "generated") === "true";
    const generatedType = frontmatterValue(content, "type");
    const slug = frontmatterValue(content, "slug");
    if (slug) slugFiles.set(slug, [...(slugFiles.get(slug) ?? []), file]);

    if (generated) {
      if (
        !content.startsWith("---\n") ||
        !content.includes(GENERATED_START) ||
        !content.includes(GENERATED_END)
      ) {
        issue(
          errors,
          "error",
          "malformed-generated-page",
          file,
          config.root,
          "Generated page markers/frontmatter are incomplete",
        );
      }
      if (
        !frontmatterValue(content, "title") ||
        !frontmatterValue(content, "type")
      ) {
        issue(
          errors,
          "error",
          "missing-generated-provenance",
          file,
          config.root,
          "Generated page lacks title or type metadata",
        );
      }
      if (
        generatedType === "source" &&
        (!frontmatterValue(content, "source_id") ||
          !frontmatterValue(content, "source_hash") ||
          !frontmatterValue(content, "provenance_kind") ||
          !frontmatterValue(content, "provenance_input"))
      ) {
        issue(
          errors,
          "error",
          "missing-generated-provenance",
          file,
          config.root,
          "Generated source page lacks source hash or provenance metadata",
        );
      }
      if (
        generatedType === "concept" &&
        !/^provenance:\n(?: {2}- .+\n?)+/m.test(content)
      ) {
        issue(
          errors,
          "error",
          "missing-generated-provenance",
          file,
          config.root,
          "Generated concept page lacks source provenance entries",
        );
      }
      if (generatedType === "concept") {
        for (const sourceId of frontmatterList(content, "provenance")) {
          if (
            !(await isFile(path.join(config.sourcesDir, `${sourceId}.json`)))
          ) {
            issue(
              errors,
              "error",
              "missing-source-artifact",
              file,
              config.root,
              `Concept provenance source ${sourceId}.json is missing`,
            );
          }
        }
      }
      const generatedBody =
        content.split(GENERATED_START)[1]?.split(GENERATED_END)[0]?.trim() ??
        "";
      if (generatedBody.length < 100) {
        issue(
          warnings,
          "warning",
          "thin-generated-page",
          file,
          config.root,
          "Generated content is shorter than 100 characters",
        );
      }
      const sourceId = frontmatterValue(content, "source_id");
      if (
        sourceId &&
        !(await isFile(path.join(config.sourcesDir, `${sourceId}.json`)))
      ) {
        issue(
          errors,
          "error",
          "missing-source-artifact",
          file,
          config.root,
          `Source artifact ${sourceId}.json is missing`,
        );
      }
    }

    const sourceTextIndex =
      generatedType === "source" ? content.indexOf("\n## Source text\n") : -1;
    const linkContent =
      sourceTextIndex >= 0 ? content.slice(0, sourceTextIndex) : content;
    for (const match of linkContent.matchAll(
      /!?\[[^\]]*]\(([^)]+)\)|\[\[([^|\]]+)(?:\|[^\]]+)?]]/g,
    )) {
      const link = (match[1] ?? match[2] ?? "").trim().split("#")[0] ?? "";
      if (!link || /^(?:https?:|mailto:|#)/i.test(link)) continue;
      let decoded: string;
      try {
        decoded = decodeURIComponent(link);
      } catch {
        issue(
          errors,
          "error",
          "malformed-internal-link",
          file,
          config.root,
          `Link contains invalid percent encoding: ${link}`,
        );
        continue;
      }
      let target = path.resolve(path.dirname(file), decoded);
      if (!path.extname(target)) target += ".md";
      if (!(await isFile(target))) {
        issue(
          errors,
          "error",
          "broken-internal-link",
          file,
          config.root,
          `Link target does not exist: ${link}`,
        );
      }
    }
  }

  for (const [slug, files] of slugFiles) {
    if (files.length > 1) {
      for (const file of files) {
        issue(
          errors,
          "error",
          "duplicate-slug",
          file,
          config.root,
          `Slug "${slug}" is used by ${files.length} pages`,
        );
      }
    }
  }
  const manifest = await loadRawManifest({ root: config.root });
  const manifestIds = new Set(manifest.entries.map((entry) => entry.sourceId));
  const sourceIds = new Set(
    sourceFiles.map((file) => path.basename(file, ".json")),
  );
  for (const sourceId of sourceIds) {
    if (!manifestIds.has(sourceId)) {
      issue(
        warnings,
        "warning",
        "missing-raw-manifest",
        path.join(config.sourcesDir, `${sourceId}.json`),
        config.root,
        "Processed source has no raw reconstruction manifest entry",
      );
    }
  }
  for (const entry of manifest.entries) {
    if (!sourceIds.has(entry.sourceId)) {
      issue(
        errors,
        "error",
        "orphan-raw-manifest",
        path.join(config.rawDir, "manifest.json"),
        config.root,
        `Manifest references missing source artifact ${entry.sourceId}.json`,
      );
    }
    for (const origin of entry.origins) {
      if (!origin.targetPath) continue;
      try {
        safeRawTarget(config.rawDir, origin.targetPath);
      } catch (error) {
        issue(
          errors,
          "error",
          "unsafe-raw-target",
          path.join(config.rawDir, "manifest.json"),
          config.root,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
  errors.sort((a, b) =>
    `${a.path}:${a.code}`.localeCompare(`${b.path}:${b.code}`),
  );
  warnings.sort((a, b) =>
    `${a.path}:${a.code}`.localeCompare(`${b.path}:${b.code}`),
  );
  return { errors, warnings, ok: errors.length === 0 };
}
