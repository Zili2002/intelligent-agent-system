import { open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.js";
import {
  configuredEmbeddingProvider,
  quantizeEmbedding,
  semanticSimilarity,
} from "./semantic-index.js";
import type {
  EvidenceClue,
  EvidenceClueKind,
  EvidenceFrontierHistoryEntry,
  EvidenceFrontierStatus,
  ResolvedWikiConfig,
  ServiceOptions,
} from "./types.js";
import { readTextIfExists, sha256, writeText } from "./utils.js";

const FRONTIER_VERSION = 2;
const STALE_LOCK_MS = 5 * 60_000;

export interface EvidenceClueInput {
  query: string;
  targetId: string;
  problemId?: string;
  topicId?: string;
  kind: EvidenceClueKind;
  priority: number;
}

export function inferEvidenceTopic(
  value: string,
  kind: EvidenceClueKind,
): string {
  if (kind === "refresh") return "source-refresh";
  const text = value.toLocaleLowerCase();
  const topics: Array<[string, RegExp]> = [
    ["planning", /\b(plan|planning|reason|deliberat|chain-of-thought)\b/],
    ["tool-use", /\b(tool|function call|privilege|permission)\b/],
    ["recovery", /\b(recover|recovery|rollback|retry|fault|failure)\b/],
    ["long-horizon", /\b(long[- ]horizon|long[- ]running|persistent|memory)\b/],
    ["evaluation", /\b(evaluat|benchmark|metric|reliab|audit|validat)\b/],
    ["alignment", /\b(align|safety|reward hack|multi-agent|coordina)\b/],
  ];
  return topics.find(([, pattern]) => pattern.test(text))?.[0] ?? "general";
}

interface FrontierArtifact {
  version: 2;
  updatedAt: string;
  embeddingModel: string;
  embeddingConfigurationId: string;
  counters: {
    admitted: number;
    deduplicated: number;
    semanticDeduplicated: number;
    pruned: number;
    compacted: number;
    circuitBroken: number;
    selected: number;
  };
  items: EvidenceClue[];
  history: EvidenceFrontierHistoryEntry[];
}

function normalizeQuery(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function intentFamily(kind: EvidenceClueKind): string {
  if (kind === "challenge") return "challenge";
  if (kind === "refresh") return "refresh";
  return "evidence";
}

function clueFingerprint(query: string, kind: EvidenceClueKind): string {
  return sha256(`${intentFamily(kind)}\u0000${normalizeQuery(query)}`);
}

function canonicalId(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}._:-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

function nowDate(options: ServiceOptions): Date {
  return options.now?.() ?? new Date();
}

function addDays(value: Date, days: number): string {
  return new Date(value.getTime() + days * 86_400_000).toISOString();
}

function addMinutes(value: Date, minutes: number): string {
  return new Date(value.getTime() + minutes * 60_000).toISOString();
}

function addHours(value: Date, hours: number): string {
  return new Date(value.getTime() + hours * 3_600_000).toISOString();
}

function kindInformationValue(kind: EvidenceClueKind): number {
  return {
    refresh: 1,
    challenge: 0.9,
    support: 0.8,
    gap: 0.65,
    manual: 0.5,
  }[kind];
}

function informationGain(kind: EvidenceClueKind, priority: number): number {
  return Math.min(
    1,
    Math.max(0, kindInformationValue(kind) * 0.6 + (priority / 100) * 0.4),
  );
}

function emptyArtifact(
  now: Date,
  embeddingModel: string,
  embeddingConfigurationId: string,
): FrontierArtifact {
  return {
    version: FRONTIER_VERSION,
    updatedAt: now.toISOString(),
    embeddingModel,
    embeddingConfigurationId,
    counters: {
      admitted: 0,
      deduplicated: 0,
      semanticDeduplicated: 0,
      pruned: 0,
      compacted: 0,
      circuitBroken: 0,
      selected: 0,
    },
    items: [],
    history: [],
  };
}

function counter(counters: Record<string, unknown>, key: string): number {
  const value = counters[key] ?? 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Evidence Frontier counter ${key} is invalid`);
  }
  return value;
}

function migrateClue(value: EvidenceClue): EvidenceClue {
  const targetId = value.targetIds[0] ?? `kind-${value.kind}`;
  return {
    ...value,
    fingerprint: clueFingerprint(value.query, value.kind),
    problemId: value.problemId ?? canonicalId(targetId),
    topicId: value.topicId ?? value.kind,
    informationGain:
      value.informationGain ?? informationGain(value.kind, value.priority),
    noNoveltyCount: value.noNoveltyCount ?? 0,
    mergedCount: value.mergedCount ?? Math.max(1, value.targetIds.length),
  };
}

function validateArtifact(
  value: unknown,
  embeddingModel: string,
  embeddingConfigurationId: string,
): FrontierArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Evidence Frontier must be an object");
  }
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.items)) {
    throw new Error("Evidence Frontier items are invalid");
  }
  if (
    !data.counters ||
    typeof data.counters !== "object" ||
    Array.isArray(data.counters)
  ) {
    throw new Error("Evidence Frontier counters are invalid");
  }
  if (data.version !== 1 && data.version !== FRONTIER_VERSION) {
    throw new Error("Evidence Frontier version is unsupported");
  }
  const counters = data.counters as Record<string, unknown>;
  return {
    version: FRONTIER_VERSION,
    updatedAt:
      typeof data.updatedAt === "string"
        ? data.updatedAt
        : new Date(0).toISOString(),
    embeddingModel:
      typeof data.embeddingModel === "string"
        ? data.embeddingModel
        : embeddingModel,
    embeddingConfigurationId:
      typeof data.embeddingConfigurationId === "string"
        ? data.embeddingConfigurationId
        : embeddingConfigurationId,
    counters: {
      admitted: counter(counters, "admitted"),
      deduplicated: counter(counters, "deduplicated"),
      semanticDeduplicated: counter(counters, "semanticDeduplicated"),
      pruned: counter(counters, "pruned"),
      compacted: counter(counters, "compacted"),
      circuitBroken: counter(counters, "circuitBroken"),
      selected: counter(counters, "selected"),
    },
    items: (data.items as EvidenceClue[]).map(migrateClue),
    history: Array.isArray(data.history)
      ? (data.history as EvidenceFrontierHistoryEntry[])
      : [],
  };
}

async function loadArtifact(
  config: ResolvedWikiConfig,
  now: Date,
): Promise<FrontierArtifact> {
  const content = await readTextIfExists(
    path.join(config.metaDir, "evidence_frontier.json"),
  );
  const configured = configuredEmbeddingProvider(config);
  return content
    ? validateArtifact(
        JSON.parse(content),
        configured.model,
        configured.configurationId,
      )
    : emptyArtifact(now, configured.model, configured.configurationId);
}

async function saveArtifact(
  config: ResolvedWikiConfig,
  artifact: FrontierArtifact,
): Promise<string> {
  const target = path.join(config.metaDir, "evidence_frontier.json");
  await writeText(target, JSON.stringify(artifact, null, 2));
  return target;
}

async function withFrontierLock<T>(
  config: ResolvedWikiConfig,
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(config.metaDir, "evidence_frontier.lock");
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
      );
      await handle.close();
      try {
        return await action();
      } finally {
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const details = await stat(lockPath);
        if (Date.now() - details.mtimeMs > STALE_LOCK_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw inspectionError;
        }
      }
      await sleep(25);
    }
  }
  throw new Error("Timed out acquiring the Evidence Frontier lock");
}

function active(item: EvidenceClue): boolean {
  return (
    item.status === "pending" ||
    item.status === "running" ||
    item.status === "deferred"
  );
}

function terminal(item: EvidenceClue): boolean {
  return item.status === "resolved" || item.status === "rejected";
}

function historyEntry(
  item: EvidenceClue,
  finalStatus: EvidenceFrontierHistoryEntry["finalStatus"],
): EvidenceFrontierHistoryEntry {
  return {
    fingerprint: item.fingerprint,
    kind: item.kind,
    finalStatus,
    problemId: item.problemId,
    topicId: item.topicId,
    noNoveltyCount: item.noNoveltyCount,
    updatedAt: item.updatedAt,
  };
}

function compact(artifact: FrontierArtifact, config: ResolvedWikiConfig): void {
  const terminalItems = artifact.items
    .filter(terminal)
    .sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
  const compacted = terminalItems.slice(
    config.lifecycle.maxTerminalFrontierItems,
  );
  if (compacted.length) {
    const ids = new Set(compacted.map((item) => item.id));
    artifact.items = artifact.items.filter((item) => !ids.has(item.id));
    artifact.history.push(
      ...compacted.map((item) =>
        historyEntry(
          item,
          item.status === "resolved" ? "resolved" : "rejected",
        ),
      ),
    );
    artifact.counters.compacted += compacted.length;
  }
  artifact.history = artifact.history
    .sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    )
    .slice(0, config.lifecycle.maxFrontierHistoryItems);
}

function prune(
  artifact: FrontierArtifact,
  config: ResolvedWikiConfig,
  now: Date,
): void {
  const nowMs = now.getTime();
  const retained: EvidenceClue[] = [];
  for (const item of artifact.items) {
    const expires = Date.parse(item.expiresAt);
    if (!Number.isFinite(expires)) {
      throw new Error(`Evidence clue ${item.id} has an invalid expiry`);
    }
    if (expires <= nowMs) {
      artifact.history.push(historyEntry(item, "expired"));
      artifact.counters.pruned++;
      continue;
    }
    if (
      item.status === "running" &&
      item.lastAttemptAt &&
      nowMs - Date.parse(item.lastAttemptAt) >
        config.lifecycle.baseCooldownMinutes * 2 * 60_000
    ) {
      item.status = "deferred";
      item.nextEligibleAt = now.toISOString();
      item.updatedAt = now.toISOString();
      item.lastError = "Recovered stale running clue";
    }
    retained.push(item);
  }
  artifact.items = retained;
  compact(artifact, config);
  if (artifact.items.length > config.lifecycle.maxFrontierItems) {
    const sorted = [...artifact.items].sort(
      (left, right) =>
        Number(active(right)) - Number(active(left)) ||
        right.informationGain - left.informationGain ||
        right.priority - left.priority ||
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
    const kept = sorted.slice(0, config.lifecycle.maxFrontierItems);
    const keptIds = new Set(kept.map((item) => item.id));
    const removed = artifact.items.filter((item) => !keptIds.has(item.id));
    artifact.history.push(
      ...removed.map((item) => historyEntry(item, "evicted")),
    );
    artifact.items = kept;
    artifact.counters.pruned += removed.length;
    compact(artifact, config);
  }
}

function occupancy(
  artifact: FrontierArtifact,
  config: ResolvedWikiConfig,
): number {
  return (
    (artifact.items.filter(active).length / config.lifecycle.maxFrontierItems) *
    100
  );
}

function admissionMode(
  artifact: FrontierArtifact,
  config: ResolvedWikiConfig,
): EvidenceFrontierStatus["admissionMode"] {
  const percent = occupancy(artifact, config);
  if (percent >= config.lifecycle.criticalWatermarkPercent) return "critical";
  if (percent >= config.lifecycle.highWatermarkPercent) return "throttled";
  return "normal";
}

function statusFor(
  pathName: string,
  artifact: FrontierArtifact,
  config: ResolvedWikiConfig,
): EvidenceFrontierStatus {
  const count = (status: EvidenceClue["status"]) =>
    artifact.items.filter((item) => item.status === status).length;
  const activeItems = artifact.items.filter(active).length;
  return {
    path: pathName,
    items: artifact.items.length,
    pending: count("pending"),
    running: count("running"),
    deferred: count("deferred"),
    resolved: count("resolved"),
    rejected: count("rejected"),
    capacity: config.lifecycle.maxFrontierItems,
    availableCapacity: Math.max(
      0,
      config.lifecycle.maxFrontierItems - activeItems,
    ),
    activeItems,
    occupancyPercent:
      Math.round((activeItems / config.lifecycle.maxFrontierItems) * 10_000) /
      100,
    admissionMode: admissionMode(artifact, config),
    historyItems: artifact.history.length,
    admittedTotal: artifact.counters.admitted,
    deduplicatedTotal: artifact.counters.deduplicated,
    semanticDeduplicatedTotal: artifact.counters.semanticDeduplicated,
    prunedTotal: artifact.counters.pruned,
    compactedTotal: artifact.counters.compacted,
    circuitBrokenTotal: artifact.counters.circuitBroken,
    selectedTotal: artifact.counters.selected,
  };
}

async function embedQueries(
  queries: string[],
  config: ResolvedWikiConfig,
  options: ServiceOptions,
): Promise<number[][]> {
  if (!queries.length) return [];
  const configured = configuredEmbeddingProvider(config);
  const provider = options.embeddingProvider ?? configured;
  if (
    provider.model !== configured.model ||
    (provider.configurationId !== undefined &&
      provider.configurationId !== configured.configurationId)
  ) {
    throw new Error(
      `Frontier embedding provider ${provider.configurationId ?? provider.model} does not match configured provider ${configured.configurationId}`,
    );
  }
  const output: number[][] = [];
  for (
    let index = 0;
    index < queries.length;
    index += config.retrieval.embeddingBatchSize
  ) {
    output.push(
      ...(await provider.embed(
        queries.slice(index, index + config.retrieval.embeddingBatchSize),
        "query",
      )),
    );
  }
  return output;
}

function mergeClue(
  existing: EvidenceClue,
  input: EvidenceClueInput,
  now: Date,
  config: ResolvedWikiConfig,
): void {
  existing.targetIds = [
    ...new Set([...existing.targetIds, input.targetId.trim()]),
  ].sort();
  existing.priority = Math.max(existing.priority, input.priority);
  existing.informationGain = Math.max(
    existing.informationGain,
    informationGain(input.kind, input.priority),
  );
  existing.mergedCount++;
  existing.updatedAt = now.toISOString();
  if (input.kind === "refresh" && existing.status === "resolved") {
    existing.attempts = 0;
    existing.expiresAt = addDays(now, config.lifecycle.clueTtlDays);
    delete existing.resultCount;
    delete existing.importedCount;
    if (existing.noNoveltyCount >= config.lifecycle.noNoveltyCircuitBreaker) {
      existing.status = "deferred";
      existing.nextEligibleAt = addHours(
        now,
        config.lifecycle.noNoveltyCooldownHours,
      );
    } else {
      existing.status = "pending";
      delete existing.nextEligibleAt;
    }
  }
}

export async function getEvidenceFrontierStatus(
  options: ServiceOptions = {},
): Promise<EvidenceFrontierStatus> {
  const config = await loadConfig(options.root);
  return withFrontierLock(config, async () => {
    const now = nowDate(options);
    const artifact = await loadArtifact(config, now);
    prune(artifact, config, now);
    artifact.updatedAt = now.toISOString();
    const target = await saveArtifact(config, artifact);
    return statusFor(target, artifact, config);
  });
}

export async function admitEvidenceClues(
  inputs: EvidenceClueInput[],
  options: ServiceOptions = {},
): Promise<{ clues: EvidenceClue[]; status: EvidenceFrontierStatus }> {
  const config = await loadConfig(options.root);
  return withFrontierLock(config, async () => {
    const now = nowDate(options);
    const artifact = await loadArtifact(config, now);
    prune(artifact, config, now);
    const configured = configuredEmbeddingProvider(config);
    if (
      artifact.embeddingModel !== configured.model ||
      artifact.embeddingConfigurationId !== configured.configurationId
    ) {
      artifact.embeddingModel = configured.model;
      artifact.embeddingConfigurationId = configured.configurationId;
      for (const item of artifact.items) delete item.semanticVector;
    }
    const prepared = inputs.map((input) => {
      const query = input.query.trim();
      if (!query || query.length > 500) {
        throw new Error("Evidence clue query must contain 1 to 500 characters");
      }
      const targetId = input.targetId.trim();
      if (!targetId || targetId.length > 200) {
        throw new Error("Evidence clue targetId is invalid");
      }
      if (
        !Number.isFinite(input.priority) ||
        input.priority < 0 ||
        input.priority > 100
      ) {
        throw new Error("Evidence clue priority must be from 0 to 100");
      }
      const problemId = canonicalId(input.problemId ?? targetId);
      const topicId = canonicalId(input.topicId ?? input.kind);
      if (!problemId || !topicId) {
        throw new Error("Evidence clue problemId and topicId are invalid");
      }
      return {
        input: { ...input, targetId, query },
        fingerprint: clueFingerprint(query, input.kind),
        problemId,
        topicId,
      };
    });
    const byFingerprint = new Map(
      artifact.items.map((item) => [item.fingerprint, item]),
    );
    const historyFingerprints = new Set(
      artifact.history.map((item) => item.fingerprint),
    );
    const unresolved = prepared.filter(
      (item) =>
        !byFingerprint.has(item.fingerprint) &&
        !historyFingerprints.has(item.fingerprint),
    );
    const semanticEnabled = config.lifecycle.semanticClueDedupThreshold < 1;
    const missingExisting = semanticEnabled
      ? artifact.items.filter((item) => !item.semanticVector)
      : [];
    const vectors = semanticEnabled
      ? await embedQueries(
          [
            ...missingExisting.map((item) => item.query),
            ...unresolved.map((item) => item.input.query),
          ],
          config,
          options,
        )
      : [];
    for (let index = 0; index < missingExisting.length; index++) {
      missingExisting[index]!.semanticVector = quantizeEmbedding(
        vectors[index]!,
      );
    }
    const unresolvedVectors = vectors.slice(missingExisting.length);
    const vectorByFingerprint = new Map(
      unresolved.map((item, index) => [
        item.fingerprint,
        unresolvedVectors[index]!,
      ]),
    );
    const admitted: EvidenceClue[] = [];
    for (const item of prepared) {
      const exact = byFingerprint.get(item.fingerprint);
      if (exact) {
        mergeClue(exact, item.input, now, config);
        artifact.counters.deduplicated++;
        admitted.push(exact);
        continue;
      }
      if (historyFingerprints.has(item.fingerprint)) {
        artifact.counters.deduplicated++;
        continue;
      }
      const vector = vectorByFingerprint.get(item.fingerprint);
      const semantic = vector
        ? artifact.items
            .filter(
              (candidate) =>
                intentFamily(candidate.kind) ===
                  intentFamily(item.input.kind) &&
                candidate.semanticVector &&
                semanticSimilarity(vector, candidate.semanticVector) >=
                  config.lifecycle.semanticClueDedupThreshold,
            )
            .sort(
              (left, right) =>
                semanticSimilarity(vector, right.semanticVector!) -
                  semanticSimilarity(vector, left.semanticVector!) ||
                right.informationGain - left.informationGain,
            )[0]
        : undefined;
      if (semantic) {
        mergeClue(semantic, item.input, now, config);
        artifact.counters.semanticDeduplicated++;
        admitted.push(semantic);
        continue;
      }
      const mode = admissionMode(artifact, config);
      const minimumPriority =
        mode === "critical"
          ? config.lifecycle.criticalWatermarkMinPriority
          : mode === "throttled"
            ? config.lifecycle.highWatermarkMinPriority
            : 0;
      if (
        item.input.kind !== "refresh" &&
        item.input.priority < minimumPriority
      ) {
        artifact.counters.pruned++;
        continue;
      }
      const targetActive = artifact.items.filter(
        (candidate) =>
          active(candidate) &&
          candidate.targetIds.includes(item.input.targetId),
      ).length;
      const problemActive = artifact.items.filter(
        (candidate) =>
          active(candidate) && candidate.problemId === item.problemId,
      ).length;
      const topicActive = artifact.items.filter(
        (candidate) => active(candidate) && candidate.topicId === item.topicId,
      ).length;
      if (
        targetActive >= config.lifecycle.maxPendingPerTarget ||
        problemActive >= config.lifecycle.maxActivePerProblem ||
        topicActive >= config.lifecycle.maxActivePerTopic
      ) {
        artifact.counters.pruned++;
        continue;
      }
      if (
        artifact.items.filter(active).length >=
        config.lifecycle.maxFrontierItems
      ) {
        const lowest = artifact.items
          .filter(active)
          .sort(
            (left, right) =>
              left.informationGain - right.informationGain ||
              left.priority - right.priority ||
              Date.parse(left.updatedAt) - Date.parse(right.updatedAt),
          )[0];
        const incomingGain = informationGain(
          item.input.kind,
          item.input.priority,
        );
        if (!lowest || lowest.informationGain >= incomingGain) {
          artifact.counters.pruned++;
          continue;
        }
        artifact.items = artifact.items.filter(
          (candidate) => candidate.id !== lowest.id,
        );
        artifact.history.push(historyEntry(lowest, "evicted"));
        artifact.counters.pruned++;
      }
      const clue: EvidenceClue = {
        id: `clue-${item.fingerprint.slice(0, 32)}`,
        fingerprint: item.fingerprint,
        query: item.input.query,
        targetIds: [item.input.targetId],
        problemId: item.problemId,
        topicId: item.topicId,
        kind: item.input.kind,
        priority: item.input.priority,
        informationGain: informationGain(item.input.kind, item.input.priority),
        ...(vector ? { semanticVector: quantizeEmbedding(vector) } : {}),
        status: "pending",
        attempts: 0,
        noNoveltyCount: 0,
        mergedCount: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: addDays(now, config.lifecycle.clueTtlDays),
      };
      artifact.items.push(clue);
      byFingerprint.set(item.fingerprint, clue);
      artifact.counters.admitted++;
      admitted.push(clue);
    }
    prune(artifact, config, now);
    artifact.updatedAt = now.toISOString();
    const target = await saveArtifact(config, artifact);
    return { clues: admitted, status: statusFor(target, artifact, config) };
  });
}

export async function selectEvidenceClues(
  options: ServiceOptions & { limit?: number; ids?: string[] } = {},
): Promise<{ clues: EvidenceClue[]; status: EvidenceFrontierStatus }> {
  const config = await loadConfig(options.root);
  return withFrontierLock(config, async () => {
    const now = nowDate(options);
    const artifact = await loadArtifact(config, now);
    prune(artifact, config, now);
    const requested = options.limit ?? config.lifecycle.maxQueriesPerCycle;
    const limit = Math.min(requested, config.lifecycle.maxQueriesPerCycle);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Evidence Frontier selection limit must be positive");
    }
    const utility = (item: EvidenceClue) =>
      item.informationGain -
      item.attempts * 0.08 -
      item.noNoveltyCount * 0.18 +
      Math.min(0.1, item.mergedCount * 0.01);
    const eligible = artifact.items
      .filter(
        (item) =>
          (!options.ids || options.ids.includes(item.id)) &&
          (item.status === "pending" || item.status === "deferred") &&
          item.attempts < config.lifecycle.maxAttempts &&
          (!item.nextEligibleAt ||
            Date.parse(item.nextEligibleAt) <= now.getTime()),
      )
      .sort(
        (left, right) =>
          utility(right) - utility(left) ||
          right.priority - left.priority ||
          left.attempts - right.attempts ||
          Date.parse(left.createdAt) - Date.parse(right.createdAt),
      );
    const selected: EvidenceClue[] = [];
    const selectedProblems = new Set<string>();
    const selectedTopics = new Set<string>();
    for (const clue of eligible) {
      if (selected.length >= limit) break;
      if (
        selectedProblems.has(clue.problemId) ||
        selectedTopics.has(clue.topicId)
      ) {
        continue;
      }
      selected.push(clue);
      selectedProblems.add(clue.problemId);
      selectedTopics.add(clue.topicId);
    }
    for (const clue of eligible) {
      if (selected.length >= limit) break;
      if (selected.includes(clue) || selectedProblems.has(clue.problemId)) {
        continue;
      }
      selected.push(clue);
      selectedProblems.add(clue.problemId);
    }
    for (const clue of eligible) {
      if (selected.length >= limit) break;
      if (!selected.includes(clue)) selected.push(clue);
    }
    for (const clue of selected) {
      clue.status = "running";
      clue.attempts++;
      clue.lastAttemptAt = now.toISOString();
      clue.updatedAt = now.toISOString();
      delete clue.nextEligibleAt;
      delete clue.lastError;
    }
    artifact.counters.selected += selected.length;
    artifact.updatedAt = now.toISOString();
    const target = await saveArtifact(config, artifact);
    return { clues: selected, status: statusFor(target, artifact, config) };
  });
}

export async function completeEvidenceClue(
  clueId: string,
  outcome: { resultCount: number; importedCount: number; error?: string },
  options: ServiceOptions = {},
): Promise<EvidenceFrontierStatus> {
  const config = await loadConfig(options.root);
  return withFrontierLock(config, async () => {
    const now = nowDate(options);
    const artifact = await loadArtifact(config, now);
    const clue = artifact.items.find((item) => item.id === clueId);
    if (!clue) throw new Error(`Unknown Evidence Frontier clue: ${clueId}`);
    if (!Number.isInteger(outcome.resultCount) || outcome.resultCount < 0) {
      throw new Error("Evidence clue resultCount must be non-negative");
    }
    if (!Number.isInteger(outcome.importedCount) || outcome.importedCount < 0) {
      throw new Error("Evidence clue importedCount must be non-negative");
    }
    clue.resultCount = outcome.resultCount;
    clue.importedCount = outcome.importedCount;
    clue.updatedAt = now.toISOString();
    if (outcome.importedCount > 0) {
      clue.noNoveltyCount = 0;
      clue.status = "resolved";
      delete clue.nextEligibleAt;
      delete clue.lastError;
    } else if (outcome.error && outcome.resultCount === 0) {
      clue.lastError = outcome.error.slice(0, 2_000);
      if (clue.attempts >= config.lifecycle.maxAttempts) {
        clue.status = "rejected";
        delete clue.nextEligibleAt;
      } else {
        clue.status = "deferred";
        clue.nextEligibleAt = addMinutes(
          now,
          config.lifecycle.baseCooldownMinutes * 2 ** (clue.attempts - 1),
        );
      }
    } else {
      clue.noNoveltyCount++;
      if (
        clue.noNoveltyCount >= config.lifecycle.noNoveltyCircuitBreaker &&
        clue.attempts < config.lifecycle.maxAttempts
      ) {
        clue.status = "deferred";
        clue.nextEligibleAt = addHours(
          now,
          config.lifecycle.noNoveltyCooldownHours,
        );
        clue.lastError =
          "Circuit open: repeated searches produced no new evidence";
        artifact.counters.circuitBroken++;
      } else if (clue.attempts >= config.lifecycle.maxAttempts) {
        clue.status = "rejected";
        delete clue.nextEligibleAt;
      } else {
        clue.status = "resolved";
        delete clue.nextEligibleAt;
        delete clue.lastError;
      }
    }
    prune(artifact, config, now);
    artifact.updatedAt = now.toISOString();
    const target = await saveArtifact(config, artifact);
    return statusFor(target, artifact, config);
  });
}
