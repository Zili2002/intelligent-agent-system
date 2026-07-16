import path from "node:path";
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import {
  LlmUsageTracker,
  requireLlm,
  requestJson,
  WikiLlmResponseError,
} from "./llm.js";
import type { ReflectResult, ServiceOptions } from "./types.js";
import { timestampForFile, writeText } from "./utils.js";

interface RegistryClaim {
  id: string;
  sourceId: string;
  text?: string;
  statement?: string;
  quote?: string;
  conceptIds?: string[];
  topicIds?: string[];
  status?: string;
}

interface ClaimRegistry {
  claims?: RegistryClaim[];
  sources?: Array<{
    id: string;
    title?: string;
    path?: string;
    relevant?: boolean;
  }>;
  topics?: Array<{ id: string; title?: string; claimIds?: string[] }>;
}

export async function reflectWiki(
  options: ServiceOptions = {},
): Promise<ReflectResult> {
  const config = await loadConfig(options.root);
  const provider = requireLlm(config, options);
  const compatibilityGraph = JSON.parse(
    await readFile(
      path.join(config.metaDir, "knowledge_graph.json"),
      "utf8",
    ).catch(() => {
      throw new Error(
        "No compiled LLM knowledge graph found. Run compile first.",
      );
    }),
  ) as {
    sources?: Array<{
      id: string;
      title?: string;
      relevant?: boolean;
    }>;
    concepts?: Array<{
      id: string;
      title?: string;
      definition?: string;
      claimIds?: string[];
    }>;
    claims?: Array<{
      id: string;
      sourceId?: string;
      text?: string;
      conceptIds?: string[];
    }>;
    contradictions?: Array<{ claimIds?: string[]; description?: string }>;
  };
  // The registry is authoritative; the old graph is retained only as a
  // backward-compatible source-page/concept fallback for older compilations.
  const registry = JSON.parse(
    await readFile(path.join(config.metaDir, "claims.json"), "utf8").catch(() =>
      JSON.stringify({
        claims: compatibilityGraph.claims,
        sources: compatibilityGraph.sources,
        topics: [],
      }),
    ),
  ) as ClaimRegistry;
  const claimGraph = JSON.parse(
    await readFile(path.join(config.metaDir, "claim_graph.json"), "utf8").catch(
      () => JSON.stringify({ edges: [] }),
    ),
  ) as {
    edges?: Array<{
      from?: string;
      to?: string;
      sourceId?: string;
      targetId?: string;
      type?: string;
      explanation?: string;
    }>;
  };
  const registryClaims = (registry.claims ?? []).filter(
    (claim) =>
      claim &&
      typeof claim.id === "string" &&
      typeof claim.sourceId === "string" &&
      claim.status !== "rejected",
  );
  const registrySources =
    registry.sources && registry.sources.length
      ? registry.sources
      : (compatibilityGraph.sources ?? []);
  const sourceAliases: Map<string, string> = new Map(
    registrySources.map(
      (source, index) => [`s${index + 1}`, source.id] as const,
    ),
  );
  const sourceIdAliases: Map<string, string> = new Map(
    [...sourceAliases].map(([alias, id]) => [id, alias] as const),
  );
  const claimAliases: Map<string, string> = new Map(
    registryClaims.map((claim, index) => [`c${index + 1}`, claim.id] as const),
  );
  const claimIdAliases = new Map(
    [...claimAliases].map(([alias, id]) => [id, alias] as const),
  );
  // Reflection must represent the complete registry without turning the prompt
  // into an unbounded copy of it.  Validation still knows every registry ID.
  const representativeClaims = registryClaims.slice(0, 48);
  const compactGraph = {
    registryClaimCount: registryClaims.length,
    sources: registrySources.slice(0, 48).map((source, index) => ({
      id: `s${index + 1}`,
      title: source.title,
      relevant: source.relevant,
    })),
    concepts: (compatibilityGraph.concepts ?? []).map((concept) => ({
      id: concept.id,
      title: concept.title,
    })),
    topics: (registry.topics ?? []).map((topic) => ({
      id: topic.id,
      title: topic.title,
      claimCount: topic.claimIds?.length ?? 0,
    })),
    claims: representativeClaims.map((claim) => ({
      id: claimIdAliases.get(claim.id),
      sourceId: claim.sourceId
        ? sourceIdAliases.get(claim.sourceId)
        : undefined,
      text: (claim.statement ?? claim.text ?? "").slice(0, 180),
      topicIds: claim.topicIds,
    })),
    relationships: (claimGraph.edges ?? [])
      .map((edge) => {
        const from = edge.from ?? edge.sourceId;
        const to = edge.to ?? edge.targetId;
        return {
          from: from ? claimIdAliases.get(from) : undefined,
          to: to ? claimIdAliases.get(to) : undefined,
          type: edge.type,
          explanation: edge.explanation?.slice(0, 180),
        };
      })
      .filter((edge) => edge.from && edge.to)
      .slice(0, 64),
  };
  const usage = new LlmUsageTracker(options.maxLlmTokens);
  const validateReflection = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("reflection must be an object");
    const data = value as Record<string, unknown>;
    if (!Array.isArray(data.observations))
      throw new Error("observations must be an array");
    const observations = data.observations.map((item, index) => {
      const observation =
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : undefined;
      if (
        !observation ||
        typeof observation.text !== "string" ||
        !observation.text.trim() ||
        !Array.isArray(observation.sourceIds) ||
        !Array.isArray(observation.claimIds) ||
        observation.sourceIds.some((id) => typeof id !== "string") ||
        observation.claimIds.some((id) => typeof id !== "string")
      )
        throw new Error(`invalid observation ${index}`);
      const observationSourceIds = observation.sourceIds as string[];
      const observationClaimIds = observation.claimIds as string[];
      if (!observationSourceIds.length && !observationClaimIds.length)
        throw new Error("observations must cite a source or claim");
      if (
        observationSourceIds.some((id) => !sourceAliases.has(id)) ||
        observationClaimIds.some((id) => !claimAliases.has(id))
      )
        throw new Error("reflection cited an unknown source or claim ID");
      return {
        text: observation.text.trim(),
        sourceIds: observationSourceIds.map((id) => sourceAliases.get(id)!),
        claimIds: observationClaimIds.map((id) => claimAliases.get(id)!),
      };
    });
    if (!Array.isArray(data.gaps)) throw new Error("gaps must be an array");
    const gaps = data.gaps.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new Error("gap must be object");
      const gap = item as Record<string, unknown>;
      if (
        typeof gap.priority !== "number" ||
        !Number.isInteger(gap.priority) ||
        gap.priority < 1 ||
        gap.priority > 10 ||
        typeof gap.description !== "string" ||
        !gap.description.trim() ||
        typeof gap.searchQuery !== "string" ||
        !gap.searchQuery.trim()
      )
        throw new Error("invalid reflection gap");
      return {
        priority: gap.priority,
        description: gap.description.trim(),
        searchQuery: gap.searchQuery.trim(),
      };
    });
    return { observations, gaps };
  };
  const prompt = `For focus "${config.researchFocus}", review this compact full-registry, topic, and relationship summary. Return concise JSON {observations:[{text:string,sourceIds:string[],claimIds:string[]}],gaps:[{priority:integer 1-10,description:string,searchQuery:string}]}. Cite only supplied s#/c# alias IDs. registryClaimCount covers the entire accepted registry; claims are bounded deterministic representatives. Maximum 3 observations and 3 gaps.\n${JSON.stringify(compactGraph)}`;
  let reflection;
  try {
    reflection = await requestJson(
      provider,
      {
        purpose: "reflection",
        maxTokens: config.llm.reflectionOutputTokens,
        prompt,
      },
      validateReflection,
      usage,
    );
  } catch (error) {
    if (
      !(error instanceof WikiLlmResponseError) ||
      !error.message.includes("invalid schema")
    ) {
      throw error;
    }
    reflection = await requestJson(
      provider,
      {
        purpose: "reflection",
        maxTokens: config.llm.reflectionOutputTokens,
        prompt: `${prompt}\nPrevious output failed validation: ${error.message}. Return corrected JSON only; priority must be an integer from 1 to 10.`,
      },
      validateReflection,
      usage,
    );
  }
  const now = (options.now ?? (() => new Date()))();
  const reflectionPath = path.join(
    config.metaDir,
    "reflection",
    `${timestampForFile(now)}.md`,
  );
  const gapsPath = path.join(config.metaDir, "gaps.json");
  await writeText(
    reflectionPath,
    `# LLM knowledge reflection\n\nGenerated: ${now.toISOString()}\n\n## Observations\n\n${reflection.observations.map((observation) => `- ${observation.text}\n  - Sources: ${observation.sourceIds.map((id) => `\`${id}\``).join(", ") || "_none_"}\n  - Claims: ${observation.claimIds.map((id) => `\`${id}\``).join(", ") || "_none_"}`).join("\n") || "_None._"}\n\n## Learning plan\n\n${reflection.gaps.map((gap) => `- P${gap.priority}: ${gap.description}\n  - Search query: \`${gap.searchQuery}\``).join("\n") || "_No gaps._"}`,
  );
  await writeText(
    path.join(config.metaDir, "reflection", `${timestampForFile(now)}.json`),
    JSON.stringify(
      { version: 1, generatedAt: now.toISOString(), ...reflection },
      null,
      2,
    ),
  );
  await writeText(
    gapsPath,
    JSON.stringify({ version: 1, gaps: reflection.gaps }, null, 2),
  );
  await writeText(
    path.join(config.metaDir, "gaps.md"),
    `# Knowledge gaps\n\n${reflection.gaps.map((gap) => `- P${gap.priority}: ${gap.description}\n  - Search query: \`${gap.searchQuery}\``).join("\n") || "_No gaps._"}`,
  );
  const evolutionPath = path.join(config.metaDir, "evolution_log.md");
  const existing = await readFile(evolutionPath, "utf8").catch(
    () => "# Evolution log\n",
  );
  await writeText(
    evolutionPath,
    `${existing.trimEnd()}\n\n- ${now.toISOString()}: LLM knowledge reflection observations=${reflection.observations.length}, gaps=${reflection.gaps.length}`,
  );
  return {
    reflectionPath,
    gapsPath,
    gaps: reflection.gaps.map((gap) => gap.searchQuery),
    observations: reflection.observations.map(
      (observation) => observation.text,
    ),
    usage: usage.result(),
  };
}
