import path from "node:path";
import type {
  ContradictionAdjudication,
  EvidenceStatus,
  LiteratureMetadata,
  SourceArtifact,
} from "./types.js";
import {
  generatedDocument,
  readTextIfExists,
  slugify,
  walkFiles,
  writeText,
} from "./utils.js";

export const QUALITY_VERSION = 1;

export interface SourceScore {
  sourceId: string;
  score: number;
  components: Record<string, number>;
  positiveReasons: string[];
  penalties: string[];
  evidenceClass:
    | "full-text"
    | "metadata-only"
    | "experiment"
    | "synthetic-experiment";
  sourceKind: SourceArtifact["provenance"]["kind"];
  identifiers: Record<string, string>;
}

export interface ClaimConfidence {
  claimId: string;
  confidence: number;
  sourceScore: number;
  independentSupportSources: number;
  supportCount: number;
  qualifyCount: number;
  duplicateCount: number;
  contradictionCount: number;
  evidenceStatus: EvidenceStatus;
  reasons: string[];
  penalties: string[];
}

export interface QualityClaim {
  id: string;
  sourceId: string;
  statement: string;
  quote: string;
  locator?: unknown;
  sourceTitle?: string;
  sourcePath?: string;
}

export interface QualityEdge {
  from: string;
  to: string;
  type: "supports" | "contradicts" | "qualifies" | "duplicate";
  explanation: string;
}

export interface QualityArtifacts {
  sourceScores: SourceScore[];
  claimConfidence: ClaimConfidence[];
}

function clamp(value: number, maximum = 100): number {
  return Math.max(0, Math.min(maximum, Math.round(value)));
}

function metadataCompleteness(
  metadata: LiteratureMetadata | undefined,
): number {
  if (!metadata) return 0;
  return (
    (metadata.authors?.length ? 3 : 0) +
    (metadata.published || metadata.year ? 3 : 0) +
    (metadata.venue ? 2 : 0)
  );
}

function sourceProviders(source: SourceArtifact): string[] {
  return [
    ...(source.literature?.providers ?? []),
    ...(source.literature?.sourceProvenance?.map((item) => item.provider) ??
      []),
    source.literature?.provider,
    source.provenance.provider,
  ].filter((value): value is string => Boolean(value));
}

function isSynthetic(source: SourceArtifact): boolean {
  return (
    source.provenance.kind === "experiment" ||
    source.provenanceHistory.some(
      (provenance) => provenance.kind === "experiment",
    )
  );
}

function isFullText(source: SourceArtifact): boolean {
  return !source.mediaType.includes("llmwiki.search-result");
}

export function scoreSource(
  source: SourceArtifact,
  now = new Date(),
): SourceScore {
  const metadata = source.literature;
  const fullText = isFullText(source);
  const synthetic = isSynthetic(source);
  const experiment = source.provenance.kind === "experiment";
  const components: Record<string, number> = {
    content: fullText ? 25 : 5,
    identifiers: 0,
    metadata: metadataCompleteness(metadata),
    citations: 0,
    workType: metadata?.workType ? 2 : 0,
    openAccess: metadata?.openAccess ? 7 : 0,
    license: metadata?.license ? 5 : 0,
    providerDiversity: 0,
    recency: 0,
    provenance: experiment ? 2 : source.provenance.kind === "search" ? 4 : 7,
  };
  const identifiers: Record<string, string> = {};
  if (metadata?.doi) {
    components.identifiers = (components.identifiers ?? 0) + 7;
    identifiers.doi = metadata.doi;
  }
  if (metadata?.arxivId) {
    components.identifiers = (components.identifiers ?? 0) + 5;
    identifiers.arxivId = metadata.arxivId;
  }
  if (metadata?.openAlexId) {
    components.identifiers = (components.identifiers ?? 0) + 3;
    identifiers.openAlexId = metadata.openAlexId;
  }
  const citationCount = Math.max(0, metadata?.citationCount ?? 0);
  components.citations = Math.min(
    12,
    Math.round((12 * Math.log1p(citationCount)) / Math.log1p(1_000)),
  );
  components.providerDiversity = Math.min(
    8,
    Math.max(0, new Set(sourceProviders(source)).size - 1) * 4,
  );
  const year = metadata?.year ?? Number(metadata?.published?.slice(0, 4));
  const age = Number.isInteger(year) ? now.getUTCFullYear() - year! : undefined;
  components.recency =
    age === undefined || age < 0 ? 0 : age <= 2 ? 5 : age <= 5 ? 3 : 1;
  const positiveReasons = [
    ...(fullText
      ? ["normalized full text is available"]
      : ["metadata-only evidence"]),
    ...(metadata?.doi ? ["DOI identifier"] : []),
    ...(metadata?.arxivId ? ["arXiv identifier"] : []),
    ...(metadata?.openAlexId ? ["OpenAlex identifier"] : []),
    ...(citationCount
      ? [`${citationCount} citations (logarithmically bounded)`]
      : []),
    ...(metadata?.openAccess ? ["open access"] : []),
    ...(metadata?.license ? [`license: ${metadata.license}`] : []),
    ...(metadata?.workType
      ? [`provider work type: ${metadata.workType} (not peer-review status)`]
      : []),
    ...(components.providerDiversity ? ["independent provider metadata"] : []),
  ];
  const penalties: string[] = [];
  let score = Object.values(components).reduce(
    (total, value) => total + value,
    0,
  );
  if (!fullText) {
    score -= 10;
    penalties.push("metadata-only evidence penalty");
  }
  if (!metadata?.license) {
    score -= 4;
    penalties.push("license is unknown");
  }
  if (metadata?.isRetracted === true) {
    score -= 55;
    penalties.push("explicit provider retraction; score capped at 15");
  }
  if (synthetic) {
    score -= 20;
    penalties.push(
      "explicit synthetic simulation evidence; score capped at 40",
    );
  }
  const evidenceClass = synthetic
    ? "synthetic-experiment"
    : experiment
      ? "experiment"
      : fullText
        ? "full-text"
        : "metadata-only";
  return {
    sourceId: source.id,
    score: clamp(
      score,
      metadata?.isRetracted === true
        ? 15
        : synthetic
          ? 40
          : !fullText
            ? 55
            : 100,
    ),
    components,
    positiveReasons,
    penalties,
    evidenceClass,
    sourceKind: source.provenance.kind,
    identifiers,
  };
}

export function buildQualityArtifacts(
  sources: SourceArtifact[],
  claims: QualityClaim[],
  edges: QualityEdge[],
  now = new Date(),
): QualityArtifacts {
  const sourceScores = sources.map((source) => scoreSource(source, now));
  const bySource = new Map(
    sourceScores.map((score) => [score.sourceId, score]),
  );
  const byClaim = new Map(claims.map((claim) => [claim.id, claim]));
  const claimConfidence = claims.map((claim): ClaimConfidence => {
    const incident = edges.filter(
      (edge) => edge.from === claim.id || edge.to === claim.id,
    );
    const count = (type: QualityEdge["type"]) =>
      incident.filter((edge) => edge.type === type).length;
    const supportNeighbors = incident
      .filter((edge) => edge.type === "supports" || edge.type === "duplicate")
      .map((edge) => byClaim.get(edge.from === claim.id ? edge.to : edge.from))
      .filter((entry): entry is QualityClaim => Boolean(entry));
    const supportSources = new Set([
      claim.sourceId,
      ...supportNeighbors.map((item) => item.sourceId),
    ]);
    const independentSupportSources = Math.max(0, supportSources.size - 1);
    const sourceScore = bySource.get(claim.sourceId)?.score ?? 0;
    const contradictionCount = count("contradicts");
    const supportCount = count("supports");
    const qualifyCount = count("qualifies");
    const duplicateCount = count("duplicate");
    const ownClass = bySource.get(claim.sourceId)?.evidenceClass;
    const ownSynthetic = ownClass === "synthetic-experiment";
    const actualExperiment = ownClass === "experiment";
    let confidence =
      sourceScore * 0.65 +
      independentSupportSources * 12 +
      qualifyCount * 2 +
      duplicateCount * 2 -
      contradictionCount * 18;
    const reasons = [
      `source score contributes ${Math.round(sourceScore * 0.65)} points`,
    ];
    const penalties: string[] = [];
    if (independentSupportSources > 0)
      reasons.push(
        `${independentSupportSources} independent supporting source(s)`,
      );
    if (qualifyCount)
      reasons.push(`${qualifyCount} qualifying relationship(s)`);
    if (contradictionCount)
      penalties.push(`${contradictionCount} contradiction(s)`);
    let status: EvidenceStatus;
    if (contradictionCount) status = "contested";
    else if (ownSynthetic && independentSupportSources === 0)
      status = "synthetic-only";
    else if (independentSupportSources > 0) status = "corroborated";
    else if (actualExperiment) status = "experiment-supported";
    else if (sourceScore < 25) status = "insufficient";
    else status = "single-source";
    if (supportSources.size === 1) {
      confidence = Math.min(confidence, 70);
      penalties.push("single-source confidence cap");
    }
    if (ownSynthetic) {
      confidence = Math.min(confidence, 45);
      penalties.push("synthetic-origin confidence cap");
    }
    if (status === "insufficient") {
      confidence = Math.min(confidence, 35);
      penalties.push("insufficient source evidence cap");
    }
    return {
      claimId: claim.id,
      confidence: clamp(confidence),
      sourceScore,
      independentSupportSources,
      supportCount,
      qualifyCount,
      duplicateCount,
      contradictionCount,
      evidenceStatus: status,
      reasons,
      penalties,
    };
  });
  return { sourceScores, claimConfidence };
}

async function removeStaleGenerated(
  directory: string,
  wanted: Set<string>,
): Promise<void> {
  for (const file of await walkFiles(directory, ".md")) {
    if (wanted.has(file)) continue;
    const content = await readTextIfExists(file);
    if (
      content?.includes('generated: "true"') &&
      content.includes("<!-- llmwiki:generated:start -->")
    ) {
      const { rm } = await import("node:fs/promises");
      await rm(file);
    }
  }
}

function locator(claim: QualityClaim): string {
  const value = claim.locator as Record<string, unknown> | undefined;
  if (!value) return "exact locator unavailable";
  return [
    typeof value.chunkIndex === "number"
      ? `chunk ${value.chunkIndex + 1}`
      : undefined,
    typeof value.start === "number" && typeof value.end === "number"
      ? `offsets ${value.start}-${value.end}`
      : undefined,
    typeof value.section === "string" ? `section ${value.section}` : undefined,
    typeof value.page === "number" ? `page ${value.page}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
}

function markdownProse(value: string): string {
  return value.replace(/\[\[/g, "\\[\\[");
}

export async function writeQualityPages(
  wikiDir: string,
  artifacts: QualityArtifacts,
  claims: QualityClaim[],
  edges: QualityEdge[],
  adjudications: ContradictionAdjudication[] = [],
): Promise<void> {
  const sourceById = new Map(
    artifacts.sourceScores.map((item) => [item.sourceId, item]),
  );
  const confidenceById = new Map(
    artifacts.claimConfidence.map((item) => [item.claimId, item]),
  );
  const sourceRows = artifacts.sourceScores.map(
    (item) =>
      `- \`${item.sourceId}\`: **${item.score}/100** (${item.evidenceClass})\n  - Components: ${Object.entries(
        item.components,
      )
        .map(([key, value]) => `${key}=${value}`)
        .join(
          ", ",
        )}\n  - Strengths: ${item.positiveReasons.join("; ") || "no positive evidence signals"}${item.penalties.length ? `\n  - Penalties: ${item.penalties.join("; ")}` : ""}`,
  );
  const claimRows = artifacts.claimConfidence.map(
    (item) =>
      `- \`${item.claimId}\`: **${item.confidence}/100** (${item.evidenceStatus}); source ${item.sourceScore}/100; independent support sources: ${item.independentSupportSources}; supports/qualifies/duplicates/contradictions: ${item.supportCount}/${item.qualifyCount}/${item.duplicateCount}/${item.contradictionCount}`,
  );
  const qualityDir = path.join(wikiDir, "quality");
  await writeText(
    path.join(qualityDir, "sources.md"),
    generatedDocument(
      {
        title: "Source quality",
        slug: "source-quality",
        generated: "true",
        type: "quality",
      },
      `# Source quality\n\nScores are deterministic evidence-quality signals, not truth or peer-review claims.\n\n${sourceRows.join("\n") || "_No sources._"}`,
      await readTextIfExists(path.join(qualityDir, "sources.md")),
    ),
  );
  await writeText(
    path.join(qualityDir, "claims.md"),
    generatedDocument(
      {
        title: "Claim confidence",
        slug: "claim-confidence",
        generated: "true",
        type: "quality",
      },
      `# Claim confidence\n\nConfidence measures evidence strength, not truth probability.\n\n${claimRows.join("\n") || "_No claims._"}`,
      await readTextIfExists(path.join(qualityDir, "claims.md")),
    ),
  );
  const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
  const adjudicationByEdge = new Map(
    adjudications.flatMap((item) => [
      [`${item.from}\u0000${item.to}`, item] as const,
      [`${item.to}\u0000${item.from}`, item] as const,
    ]),
  );
  const wanted = new Set<string>();
  for (const edge of edges.filter((item) => item.type === "contradicts")) {
    const from = claimsById.get(edge.from);
    const to = claimsById.get(edge.to);
    if (!from || !to) continue;
    const filename = `${slugify(`${from.id}-${to.id}`)}.md`;
    const target = path.join(wikiDir, "contradictions", filename);
    wanted.add(target);
    const adjudication = adjudicationByEdge.get(`${edge.from}\u0000${edge.to}`);
    const entry = (claim: QualityClaim) => {
      const score = sourceById.get(claim.sourceId)?.score ?? 0;
      const confidence = confidenceById.get(claim.id);
      const sourcePath = (
        claim.sourcePath ?? `sources/${claim.sourceId}.md`
      ).replace(/^wiki\//, "");
      return `- Claim: \`${claim.id}\`\n- Statement: ${markdownProse(claim.statement)}\n- Immutable quote: “${markdownProse(claim.quote)}”\n- Source: [[../${sourcePath}|${claim.sourceTitle ?? claim.sourceId}]] (${locator(claim)})\n- Source score: ${score}/100\n- Claim confidence: ${confidence?.confidence ?? 0}/100 (${confidence?.evidenceStatus ?? "insufficient"})`;
    };
    await writeText(
      target,
      generatedDocument(
        {
          title: "Contradiction adjudication",
          slug: filename.slice(0, -3),
          generated: "true",
          type: "contradiction",
        },
        `# Contradiction adjudication\n\n## Claim A\n\n${entry(from)}\n\n## Claim B\n\n${entry(to)}\n\n## Relationship explanation\n\n${markdownProse(edge.explanation)}\n\n## Resolution status\n\n**${adjudication?.resolution ?? "unresolved"}**${adjudication ? ` — ${markdownProse(adjudication.rationale)}\n\n## Evidence used\n\n${adjudication.evidenceClaimIds.map((id) => `- \`${id}\``).join("\n") || "_Only the conflicting pair was available._"}\n\n## Remaining evidence needs\n\n${adjudication.evidenceNeeds.map((need) => `- ${markdownProse(need)}`).join("\n") || "_None identified._"}` : " — the contradiction has not yet been adjudicated."}`,
        await readTextIfExists(target),
      ),
    );
  }
  await removeStaleGenerated(path.join(wikiDir, "contradictions"), wanted);
}
