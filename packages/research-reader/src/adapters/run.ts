import { readFile } from "node:fs/promises";
import path from "node:path";
import { WikiCompiler } from "@intelligent-agent-system/llm-wiki-compiler";
import {
  canonicalLiteratureKey,
  mergeLiteratureMetadata,
  paperIdFromCanonicalKey,
} from "../identity.js";
import { appendPaperNote } from "../notes.js";
import { mutatePaperPassport } from "../store.js";
import type { PaperPassport, ResolvedReaderConfig } from "../types.js";
import { literatureAdapterRegistry } from "./registry.js";
import type { AdapterRunOptions, AdapterRunResult } from "./types.js";

export async function runLiteratureAdapter(
  config: ResolvedReaderConfig,
  adapterName: string,
  source: string,
  options: AdapterRunOptions = {},
): Promise<AdapterRunResult> {
  const adapter = literatureAdapterRegistry.get(adapterName);
  const result = await adapter.import({
    source,
    root: config.root,
    ...(options.approveNetwork === true ? { approveNetwork: true } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  const limit = options.limit ?? 1_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("Adapter import limit must be from 1 to 10000");
  }
  const items = result.items.slice(0, limit);
  if (result.items.length > limit) {
    result.warnings.push(
      `Central adapter limit stopped ${result.items.length - limit} item(s)`,
    );
  }
  const wiki = new WikiCompiler({ root: config.root });
  let imported = 0;
  let createdPapers = 0;
  let updatedPapers = 0;
  const paperIds: string[] = [];
  for (const item of items) {
    const canonicalKey = canonicalLiteratureKey(item.metadata);
    let sourceId: string | undefined;
    if (item.content !== undefined) {
      const originalData = item.filePath
        ? new Uint8Array(await readFile(item.filePath))
        : undefined;
      const ingestion = await wiki.ingestContent(
        item.content,
        item.filePath ?? item.metadata.url,
        {
          title: item.metadata.title,
          mediaType: item.mediaType ?? "text/plain",
          provenanceKind: item.filePath ? "file" : "search",
          ...(item.filePath
            ? { fileName: path.basename(item.filePath) }
            : { url: item.metadata.url }),
          ...(originalData ? { originalData } : {}),
          literature: item.metadata,
        },
      );
      sourceId = ingestion.artifact.id;
      imported += 1;
    } else if (item.filePath) {
      const ingestion = await wiki.ingest(item.filePath, {
        title: item.metadata.title,
        literature: item.metadata,
      });
      sourceId = ingestion.artifact.id;
      imported += 1;
    }
    const now = new Date().toISOString();
    const paperId = paperIdFromCanonicalKey(canonicalKey);
    let created = false;
    const paper = await mutatePaperPassport(config, paperId, (current) => {
      created = current === undefined;
      return current
        ? updatePaper(current, item.metadata, sourceId, item.evidenceKind, now)
        : createPaper(
            canonicalKey,
            item.metadata,
            sourceId,
            item.evidenceKind,
            now,
          );
    });
    if (item.note) await appendPaperNote(config, paper.id, item.note);
    paperIds.push(paper.id);
    if (!created) updatedPapers += 1;
    else createdPapers += 1;
  }
  return {
    adapter: adapterName,
    imported,
    createdPapers,
    updatedPapers,
    paperIds,
    warnings: result.warnings,
  };
}

function createPaper(
  canonicalKey: string,
  metadata: PaperPassport["metadata"],
  sourceId: string | undefined,
  evidenceKind: "full-text" | "abstract" | "note" | undefined,
  now: string,
): PaperPassport {
  return {
    version: 1,
    id: paperIdFromCanonicalKey(canonicalKey),
    canonicalKey,
    sourceIds: sourceId ? [sourceId] : [],
    metadata,
    discovery: [
      {
        query: metadata.url,
        provider: metadata.provider,
        runId: `adapter:${metadata.provider}`,
        discoveredAt: now,
      },
    ],
    acquisition:
      sourceId && evidenceKind === "full-text"
        ? { status: "available", fullTextSourceId: sourceId }
        : { status: "metadata-only" },
    triage: {
      relevanceScore: 0,
      confidence: 0,
      recommendation: "manual-review",
      reasons: [`Imported through ${metadata.provider} adapter`],
      profileVersion: "unscored",
      policyVersion: "adapter-v1",
    },
    reading: {
      status: "unread",
      priority: 60,
      userTags: [],
    },
    reviewIds: [],
    knowledge: {
      compiled: false,
      claimIds: [],
      wikiPaths: [],
    },
    lifecycle: {
      ...(metadata.versionId ? { latestVersionId: metadata.versionId } : {}),
      reviewStale: false,
      retracted: metadata.isRetracted === true,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function updatePaper(
  paper: PaperPassport,
  metadata: PaperPassport["metadata"],
  sourceId: string | undefined,
  evidenceKind: "full-text" | "abstract" | "note" | undefined,
  now: string,
): PaperPassport {
  const updated = structuredClone(paper);
  updated.metadata = mergeLiteratureMetadata(updated.metadata, metadata);
  if (
    metadata.versionId &&
    updated.lifecycle.latestVersionId &&
    metadata.versionId !== updated.lifecycle.latestVersionId &&
    updated.reviewIds.length
  ) {
    updated.lifecycle.reviewStale = true;
  }
  if (metadata.versionId)
    updated.lifecycle.latestVersionId = metadata.versionId;
  if (sourceId && !updated.sourceIds.includes(sourceId)) {
    updated.sourceIds.push(sourceId);
  }
  if (sourceId && evidenceKind === "full-text") {
    if (
      updated.acquisition.fullTextSourceId &&
      updated.acquisition.fullTextSourceId !== sourceId &&
      updated.reviewIds.length
    ) {
      updated.lifecycle.reviewStale = true;
    }
    updated.acquisition = { status: "available", fullTextSourceId: sourceId };
  }
  updated.updatedAt = now;
  return updated;
}
