import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "@intelligent-agent/shared";
import { listPaperPassports, listPaperReviews } from "./store.js";
import type { ReaderNavigationGraph, ResolvedReaderConfig } from "./types.js";

interface ClaimsArtifact {
  claims: Array<{
    id: string;
    sourceId: string;
    text: string;
    topicIds?: string[];
  }>;
  topics?: Array<{
    id: string;
    title: string;
    claimIds: string[];
  }>;
}

interface ClaimGraphArtifact {
  edges?: Array<{
    from: string;
    to: string;
    type: "supports" | "contradicts" | "qualifies" | "duplicate";
  }>;
}

export async function buildReaderNavigation(
  config: ResolvedReaderConfig,
  now = new Date(),
): Promise<ReaderNavigationGraph> {
  const [papers, reviews, claims, claimGraph] = await Promise.all([
    listPaperPassports(config),
    listPaperReviews(config),
    readOptionalJson<ClaimsArtifact>(
      path.join(config.root, "meta", "claims.json"),
    ),
    readOptionalJson<ClaimGraphArtifact>(
      path.join(config.root, "meta", "claim_graph.json"),
    ),
  ]);
  const nodes = new Map<string, ReaderNavigationGraph["nodes"][number]>();
  const edges: ReaderNavigationGraph["edges"] = [];
  for (const paper of papers) {
    nodes.set(paper.id, {
      id: paper.id,
      type: "paper",
      label: paper.metadata.title,
    });
  }
  const paperBySource = new Map<string, string>();
  for (const paper of papers) {
    for (const sourceId of paper.sourceIds) {
      paperBySource.set(sourceId, paper.id);
    }
  }
  for (const claim of claims?.claims ?? []) {
    nodes.set(claim.id, {
      id: claim.id,
      type: "claim",
      label: claim.text,
    });
    const paperId = paperBySource.get(claim.sourceId);
    if (paperId) edges.push({ from: paperId, to: claim.id, type: "contains" });
  }
  for (const topic of claims?.topics ?? []) {
    const topicId = `topic:${topic.id}`;
    nodes.set(topicId, {
      id: topicId,
      type: "topic",
      label: topic.title,
    });
    for (const claimId of topic.claimIds) {
      if (nodes.has(claimId)) {
        edges.push({ from: topicId, to: claimId, type: "contains" });
      }
    }
  }
  for (const edge of claimGraph?.edges ?? []) {
    if (nodes.has(edge.from) && nodes.has(edge.to)) edges.push(edge);
  }
  const latestReview = new Map<string, (typeof reviews)[number]>();
  for (const review of reviews) {
    if (!latestReview.has(review.paperId))
      latestReview.set(review.paperId, review);
  }
  for (const [paperId, review] of latestReview) {
    for (const prerequisite of review.prerequisites) {
      const prerequisiteId = `prerequisite:${slug(prerequisite)}`;
      nodes.set(prerequisiteId, {
        id: prerequisiteId,
        type: "prerequisite",
        label: prerequisite,
      });
      edges.push({ from: paperId, to: prerequisiteId, type: "requires" });
    }
  }
  const graph: ReaderNavigationGraph = {
    version: 1,
    generatedAt: now.toISOString(),
    nodes: [...nodes.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    edges: deduplicateEdges(edges),
  };
  await atomicWriteJson(path.join(config.metaDir, "navigation.json"), graph);
  return graph;
}

export async function recommendReadingPath(
  config: ResolvedReaderConfig,
  topic: string,
): Promise<{
  topic: string;
  paperIds: string[];
  prerequisites: string[];
}> {
  if (!topic.trim()) throw new Error("Reading path topic must not be empty");
  const [papers, reviews] = await Promise.all([
    listPaperPassports(config),
    listPaperReviews(config),
  ]);
  const topicTokens = tokens(topic);
  const relevant = papers
    .map((paper) => ({
      paper,
      score: overlap(
        tokens(
          `${paper.metadata.title} ${paper.reading.userTags.join(" ")} ${paper.triage?.reasons.join(" ") ?? ""}`,
        ),
        topicTokens,
      ),
    }))
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.paper.metadata.year ?? Number.MAX_SAFE_INTEGER) -
          (right.paper.metadata.year ?? Number.MAX_SAFE_INTEGER) ||
        right.paper.reading.priority - left.paper.reading.priority,
    )
    .map((item) => item.paper);
  const relevantIds = new Set(relevant.map((paper) => paper.id));
  const prerequisites = [
    ...new Set(
      reviews
        .filter((review) => relevantIds.has(review.paperId))
        .flatMap((review) => review.prerequisites),
    ),
  ].sort();
  return {
    topic,
    paperIds: relevant.map((paper) => paper.id),
    prerequisites,
  };
}

function deduplicateEdges(
  edges: ReaderNavigationGraph["edges"],
): ReaderNavigationGraph["edges"] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.from}:${edge.type}:${edge.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
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

function tokens(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{Letter}\p{Number}]+/gu)
      ?.filter((token) => token.length > 2) ?? [],
  );
}

function overlap(first: Set<string>, second: Set<string>): number {
  if (!second.size) return 0;
  let matches = 0;
  for (const token of second) if (first.has(token)) matches += 1;
  return matches / second.size;
}

function slug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLocaleLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "concept"
  );
}
