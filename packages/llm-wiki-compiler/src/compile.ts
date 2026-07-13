import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import type { CompileResult, ServiceOptions, SourceArtifact } from "./types.js";
import {
  extractiveSummary,
  generatedDocument,
  keywords,
  readTextIfExists,
  relativePosix,
  slugify,
  walkFiles,
  writeText,
} from "./utils.js";

interface GraphNode {
  id: string;
  type: "source" | "concept";
  title: string;
  path: string;
}

interface GraphEdge {
  from: string;
  to: string;
  type: "mentions";
}

async function readArtifacts(sourcesDir: string): Promise<SourceArtifact[]> {
  const artifacts: SourceArtifact[] = [];
  for (const file of await walkFiles(sourcesDir, ".json")) {
    const parsed = JSON.parse(
      await readFile(file, "utf8"),
    ) as Partial<SourceArtifact>;
    if (
      parsed.version !== 1 ||
      typeof parsed.id !== "string" ||
      typeof parsed.hash !== "string" ||
      parsed.id !== parsed.hash ||
      !/^[a-f0-9]{64}$/.test(parsed.hash) ||
      typeof parsed.content !== "string" ||
      !parsed.content.trim() ||
      typeof parsed.title !== "string" ||
      !parsed.title.trim() ||
      typeof parsed.mediaType !== "string" ||
      typeof parsed.ingestedAt !== "string" ||
      !parsed.provenance ||
      typeof parsed.provenance.input !== "string" ||
      !["file", "url", "search", "experiment"].includes(
        parsed.provenance.kind ?? "",
      )
    ) {
      throw new Error(`Malformed source artifact: ${file}`);
    }
    artifacts.push(parsed as SourceArtifact);
  }
  return artifacts.sort((a, b) => a.hash.localeCompare(b.hash));
}

function sourceBody(
  artifact: SourceArtifact,
  sourceKeywords: string[],
): string {
  const provenanceEntries = artifact.provenanceHistory?.length
    ? artifact.provenanceHistory
    : [artifact.provenance];
  const provenance = [
    ...provenanceEntries.flatMap((entry, index) => [
      `- Origin ${index + 1}: \`${entry.input.replace(/`/g, "'")}\` (${entry.kind})`,
      entry.url ? `  - URL: ${entry.url}` : undefined,
      entry.provider ? `  - Provider: ${entry.provider}` : undefined,
    ]),
    `- Media type: ${artifact.mediaType}`,
    `- Ingested: ${artifact.ingestedAt}`,
    `- SHA-256: \`${artifact.hash}\``,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
  return `# ${artifact.title}

## Extractive summary

${extractiveSummary(artifact.content)}

## Deterministic keywords

${sourceKeywords.length ? sourceKeywords.map((word) => `- [[../concepts/${slugify(word)}.md|${word}]]`).join("\n") : "- None"}

## Provenance

${provenance}

## Source text

${artifact.content}`;
}

export async function compileWiki(
  options: ServiceOptions = {},
): Promise<CompileResult> {
  const config = await loadConfig(options.root);
  const artifacts = await readArtifacts(config.sourcesDir);
  const conceptSources = new Map<string, SourceArtifact[]>();
  const graphNodes: GraphNode[] = [];
  const graphEdges: GraphEdge[] = [];
  let pagesWritten = 0;

  for (const artifact of artifacts) {
    const words = keywords(artifact.content);
    const sourceFile = `${slugify(artifact.title)}-${artifact.hash.slice(0, 8)}.md`;
    const sourcePath = path.join(config.wikiDir, "sources", sourceFile);
    const existing = await readTextIfExists(sourcePath);
    await writeText(
      sourcePath,
      generatedDocument(
        {
          title: artifact.title,
          slug: slugify(`${artifact.title}-${artifact.hash.slice(0, 8)}`),
          generated: "true",
          type: "source",
          source_id: artifact.id,
          source_hash: artifact.hash,
          provenance_kind: artifact.provenance.kind,
          provenance_input: artifact.provenance.input,
          ...(artifact.provenance.url
            ? { provenance_url: artifact.provenance.url }
            : {}),
          ...(artifact.provenance.provider
            ? { provenance_provider: artifact.provenance.provider }
            : {}),
        },
        sourceBody(artifact, words),
        existing,
      ),
    );
    pagesWritten++;
    const sourceNodeId = `source:${artifact.id}`;
    graphNodes.push({
      id: sourceNodeId,
      type: "source",
      title: artifact.title,
      path: relativePosix(config.root, sourcePath),
    });
    for (const word of words) {
      const entries = conceptSources.get(word) ?? [];
      entries.push(artifact);
      conceptSources.set(word, entries);
      graphEdges.push({
        from: sourceNodeId,
        to: `concept:${slugify(word)}`,
        type: "mentions",
      });
    }
  }

  for (const [concept, sources] of [...conceptSources].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const conceptPath = path.join(
      config.wikiDir,
      "concepts",
      `${slugify(concept)}.md`,
    );
    const sourceLinks = sources
      .sort((a, b) => a.hash.localeCompare(b.hash))
      .map((source) => {
        const sourceName = `${slugify(source.title)}-${source.hash.slice(0, 8)}.md`;
        return `- [[../sources/${sourceName}|${source.title}]] — ${extractiveSummary(source.content, 1, 180)}`;
      });
    const body = `# ${concept}

This generated concept page is an index of explicit source mentions. It does not infer facts beyond the cited extracts.

## Evidence

${sourceLinks.join("\n")}`;
    const existing = await readTextIfExists(conceptPath);
    await writeText(
      conceptPath,
      generatedDocument(
        {
          title: concept,
          slug: slugify(concept),
          generated: "true",
          type: "concept",
          provenance: sources.map((source) => source.id),
        },
        body,
        existing,
      ),
    );
    pagesWritten++;
    graphNodes.push({
      id: `concept:${slugify(concept)}`,
      type: "concept",
      title: concept,
      path: relativePosix(config.root, conceptPath),
    });
  }

  const sourceIndex = artifacts.map((artifact) => {
    const name = `${slugify(artifact.title)}-${artifact.hash.slice(0, 8)}.md`;
    return `- [[sources/${name}|${artifact.title}]]`;
  });
  const conceptIndex = [...conceptSources.keys()]
    .sort()
    .map((concept) => `- [[concepts/${slugify(concept)}.md|${concept}]]`);
  await writeText(
    path.join(config.wikiDir, "index.md"),
    `# Knowledge index

Generated deterministically from processed source artifacts.

## Sources (${artifacts.length})

${sourceIndex.join("\n") || "_No sources ingested._"}

## Concepts (${conceptSources.size})

${conceptIndex.join("\n") || "_No concepts extracted._"}`,
  );
  pagesWritten++;

  const graphPath = path.join(config.metaDir, "knowledge_graph.json");
  await writeText(
    graphPath,
    JSON.stringify(
      {
        version: 1,
        generatedBy: "llm-wiki-compiler",
        extraction: "deterministic lexical keyword frequency",
        nodes: graphNodes.sort((a, b) => a.id.localeCompare(b.id)),
        edges: graphEdges.sort((a, b) =>
          `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`),
        ),
      },
      null,
      2,
    ),
  );
  const thinConcepts = [...conceptSources]
    .filter(([, sources]) => sources.length < 2)
    .map(([concept]) => concept)
    .sort();
  const gapsPath = path.join(config.metaDir, "gaps.md");
  await writeText(
    gapsPath,
    `# Knowledge gaps and learning plan

These gaps are generated by a simple coverage heuristic: concepts supported by fewer than two sources are considered thin. They are not semantic judgments.

${thinConcepts.length ? thinConcepts.map((concept) => `- Gather independent evidence about: ${concept}`).join("\n") : "- No thin concepts detected."}`,
  );
  await writeText(
    path.join(config.metaDir, "capabilities.json"),
    JSON.stringify(
      {
        sourceCount: artifacts.length,
        conceptCount: conceptSources.size,
        evidenceEdges: graphEdges.length,
        deterministicExtraction: true,
        externalModelUsed: false,
      },
      null,
      2,
    ),
  );
  const now = (options.now ?? (() => new Date()))().toISOString();
  await writeText(
    path.join(config.metaDir, "capability_map.md"),
    `# Capability map

Generated: ${now}

## Knowledge metrics

- Processed sources: ${artifacts.length}
- Generated concepts: ${conceptSources.size}
- Evidence links: ${graphEdges.length}
- Thin concepts: ${thinConcepts.length}

## Capability metrics

- Deterministic extraction: enabled
- External model used: no
- Cited lexical query: enabled
- Active search provider: Crossref`,
  );
  const logPath = path.join(config.wikiDir, "log.md");
  const log = (await readTextIfExists(logPath)) ?? "# Compilation log\n";
  await writeText(
    logPath,
    `${log.trimEnd()}\n\n- ${now}: compiled ${artifacts.length} sources, ${conceptSources.size} concepts, and ${graphEdges.length} evidence links.`,
  );
  return {
    sources: artifacts.length,
    concepts: conceptSources.size,
    pagesWritten,
    graphPath,
    gapsPath,
  };
}
