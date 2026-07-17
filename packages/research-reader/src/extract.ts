import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText } from "@intelligent-agent/shared";
import {
  WikiCompiler,
  generatedDocument,
  loadConfig as loadWikiConfig,
  slugify,
  type CompileResult,
} from "@intelligent-agent-system/llm-wiki-compiler";
import { listPaperReviews, mutatePaperPassport } from "./store.js";
import type {
  PaperPassport,
  ReaderExtractOptions,
  ResolvedReaderConfig,
} from "./types.js";

interface ClaimsArtifact {
  version: 1;
  claims: Array<{
    id: string;
    sourceId: string;
    text: string;
    quote: string;
  }>;
  sources?: Array<{
    id: string;
    title: string;
    path: string;
  }>;
}

export async function extractPaperToWiki(
  config: ResolvedReaderConfig,
  paper: PaperPassport,
  options: ReaderExtractOptions = {},
): Promise<{
  compile?: CompileResult;
  pagePath: string;
  claimIds: string[];
}> {
  const sourceId = paper.acquisition.fullTextSourceId;
  if (!sourceId) {
    throw new Error(`Paper ${paper.id} has no acquired full-text source`);
  }
  let compile: CompileResult | undefined;
  if (options.recompile !== false) {
    compile = await new WikiCompiler({
      root: config.root,
      ...(options.approveLlm === true ? { approveLlm: true } : {}),
      ...(options.llmProvider ? { llmProvider: options.llmProvider } : {}),
      ...(options.maxLlmTokens === undefined
        ? {}
        : { maxLlmTokens: options.maxLlmTokens }),
      ...(options.now ? { now: () => options.now! } : {}),
    }).compile();
  }
  const claimsArtifact = await loadClaims(config);
  const claims = claimsArtifact.claims.filter(
    (claim) => claim.sourceId === sourceId,
  );
  const sourcePath = claimsArtifact.sources?.find(
    (source) => source.id === sourceId,
  )?.path;
  const reviews = await listPaperReviews(config, paper.id);
  const latestReview = reviews[0];
  const pagePath = path.join(
    config.wikiDir,
    "papers",
    `${slugify(paper.metadata.title).slice(0, 70)}-${paper.id.slice(-8)}.md`,
  );
  const existing = await readTextIfExists(pagePath);
  const body = `# ${paper.metadata.title}

## Metadata

- Paper ID: \`${paper.id}\`
- Canonical key: \`${paper.canonicalKey}\`
- Source ID: \`${sourceId}\`
- Source page: ${sourcePath ? `[[../../${sourcePath}|compiled source]]` : "not generated"}
- Authors: ${paper.metadata.authors?.join(", ") || "unknown"}
- Published: ${paper.metadata.published ?? paper.metadata.year ?? "unknown"}
- Reading status: ${paper.reading.status}

## Latest review

${
  latestReview
    ? `- Level: ${latestReview.level}
- Scientific quality: ${latestReview.scientificQuality?.toFixed(2) ?? "unknown"}
- Evidence confidence: ${latestReview.evidenceConfidence.toFixed(2)}
- Personal relevance: ${latestReview.personalRelevance.toFixed(2)}
- Recommendation: ${latestReview.recommendation}`
    : "_No Review._"
}

## Compiled claims

${
  claims
    .map(
      (claim) =>
        `- \`${claim.id}\`: ${claim.text}\n  - Evidence: “${claim.quote}”`,
    )
    .join("\n") || "_No compiled Claims for this source._"
}
`;
  await atomicWriteText(
    pagePath,
    generatedDocument(
      {
        title: paper.metadata.title,
        generated: "true",
        type: "paper",
        paper_id: paper.id,
        source_id: sourceId,
      },
      body,
      existing,
    ),
  );
  const completedAt = (options.now ?? new Date()).toISOString();
  const updated = await mutatePaperPassport(config, paper.id, (current) => {
    if (!current) throw new Error(`Paper not found: ${paper.id}`);
    if (current.acquisition.fullTextSourceId !== sourceId) {
      throw new Error(`Paper source changed during extraction: ${paper.id}`);
    }
    current.knowledge = {
      compiled: true,
      claimIds: claims.map((claim) => claim.id),
      wikiPaths: [
        relativePosix(config.root, pagePath),
        ...(sourcePath ? [sourcePath] : []),
      ],
      compiledAt: completedAt,
    };
    current.updatedAt = completedAt;
    return current;
  });
  return {
    ...(compile ? { compile } : {}),
    pagePath,
    claimIds: updated.knowledge.claimIds,
  };
}

async function loadClaims(
  config: ResolvedReaderConfig,
): Promise<ClaimsArtifact> {
  const wikiConfig = await loadWikiConfig(config.root);
  const filePath = path.join(wikiConfig.metaDir, "claims.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(
        "Compiled Claim Registry is missing; run extraction with recompile enabled",
      );
    }
    throw error;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("claims" in value) ||
    !Array.isArray(value.claims)
  ) {
    throw new Error("Invalid compiled Claim Registry");
  }
  return value as ClaimsArtifact;
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
