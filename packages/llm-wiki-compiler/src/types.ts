export interface WikiConfig {
  wikiPath: string;
  sourcesPath: string;
  rawPath: string;
  autoCommit: boolean;
  search: {
    /** Legacy singular provider setting, retained for existing configs. */
    provider?: SearchProviderName;
    /** Ordered provider fan-out. Results are normalized and merged before import. */
    providers: SearchProviderName[];
    resultLimit: number;
    oaOnly?: boolean;
    maxDownloads?: number;
    maxFileBytes?: number;
  };
  retrieval: {
    embeddingModel: string;
    embeddingDtype: "q4" | "q8" | "fp16" | "fp32";
    queryPrefix: string;
    passagePrefix: string;
    embeddingBatchSize: number;
    semanticWeight: number;
    lexicalWeight: number;
    graphWeight: number;
    confidenceWeight: number;
    semanticCandidateLimit: number;
  };
  lifecycle: {
    maxFrontierItems: number;
    maxPendingPerTarget: number;
    maxActivePerProblem: number;
    maxActivePerTopic: number;
    maxQueriesPerCycle: number;
    maxAttempts: number;
    clueTtlDays: number;
    baseCooldownMinutes: number;
    semanticClueDedupThreshold: number;
    highWatermarkPercent: number;
    criticalWatermarkPercent: number;
    highWatermarkMinPriority: number;
    criticalWatermarkMinPriority: number;
    noNoveltyCircuitBreaker: number;
    noNoveltyCooldownHours: number;
    maxTerminalFrontierItems: number;
    maxFrontierHistoryItems: number;
    frontierConcurrency: number;
    refreshIntervalHours: number;
  };
  llm: {
    model: string;
    /** Legacy whole-source limit retained for compatible configuration/cache keys. */
    sourceInputChars: number;
    /** Maximum normalized source characters supplied to one source-analysis call. */
    chunkInputChars: number;
    /** Bounded context overlap between adjacent source chunks. */
    chunkOverlapChars: number;
    /** Fail before making LLM calls when a source would exceed this chunk count. */
    maxChunksPerSource: number;
    adaptiveChunkThresholdChars: number;
    adaptiveChunkInputChars: number;
    analysisOutputTokens: number;
    screeningOutputTokens: number;
    synthesisOutputTokens: number;
    reflectionOutputTokens: number;
    queryOutputTokens: number;
    /** Compatibility graph selection is deliberately separate from the registry. */
    summaryClaimLimit: number;
    /** Bounded registry claims supplied to one topic synthesis request. */
    maxClaimsPerTopicPrompt: number;
    /** Bounded deterministic relationship candidates considered per compile. */
    maxRelationshipCandidates: number;
    relationshipCandidatesPerClaim: number;
    relationshipOppositionCandidatesPerClaim: number;
    /** Bounded candidate pairs supplied to one relationship request. */
    relationshipBatchSize: number;
    /** Bounded full-registry evidence candidates supplied to a query request. */
    queryCandidateLimit: number;
    analysisConcurrency: number;
    screeningConcurrency: number;
    topicConcurrency: number;
    relationshipConcurrency: number;
    adjudicationConcurrency: number;
    globalSynthesisSourceInterval: number;
    thinking: {
      type: "disabled" | "adaptive";
      effort: "low" | "medium" | "high" | "xhigh" | "max";
    };
  };
  researchFocus: string;
}

export interface ResolvedWikiConfig extends WikiConfig {
  root: string;
  configPath: string;
  wikiDir: string;
  sourcesDir: string;
  rawDir: string;
  metaDir: string;
  schemaDir: string;
}

export interface SourceProvenance {
  kind: "file" | "url" | "search" | "experiment";
  input: string;
  url?: string;
  provider?: string;
  storageUri?: string;
}

export interface SourceArtifact {
  version: 1;
  id: string;
  hash: string;
  title: string;
  mediaType: string;
  content: string;
  /** Optional offsets retained by an ingester that can map normalized text to pages. */
  pageLocators?: Array<{ start: number; end: number; page: number }>;
  provenance: SourceProvenance;
  provenanceHistory: SourceProvenance[];
  /** Normalized literature record retained independently of extracted text. */
  literature?: LiteratureMetadata;
  ingestedAt: string;
}

export interface LiteratureMetadata {
  id: string;
  title: string;
  url: string;
  provider: string;
  providers?: string[];
  doi?: string;
  arxivId?: string;
  openAlexId?: string;
  sourceId?: string;
  versionId?: string;
  authors?: string[];
  published?: string;
  year?: number;
  venue?: string;
  license?: string;
  openAccess?: boolean;
  oaStatus?: string;
  /** Provider-supplied count; scoring uses a logarithmic cap. */
  citationCount?: number;
  /** Provider classification only; this is not a peer-review assertion. */
  workType?: string;
  /** Explicit provider retraction status. Omission means unknown. */
  isRetracted?: boolean;
  sourceProvenance?: SearchSourceProvenance[];
}

export interface IngestOptions {
  title?: string;
  mediaType?: string;
  provenanceKind?: SourceArtifact["provenance"]["kind"];
  url?: string;
  provider?: string;
  storageUri?: string;
  fileName?: string;
  originalData?: Uint8Array;
  literature?: LiteratureMetadata;
}

export interface IngestResult {
  artifact: SourceArtifact;
  path: string;
  deduplicated: boolean;
}

export interface CompileResult {
  sources: number;
  concepts: number;
  pagesWritten: number;
  graphPath: string;
  gapsPath: string;
  /** Complete accepted-claim registry, not the compatibility summary graph. */
  claimsPath?: string;
  claimGraphPath?: string;
  registryCount?: number;
  summaryClaimCount?: number;
  topicCount?: number;
  relationshipCount?: number;
  contradictionCount?: number;
  globalSynthesis?: boolean;
  usage?: LlmUsage;
}

export interface QueryMatch {
  path: string;
  title: string;
  score: number;
  excerpt: string;
  confidence?: number;
  evidenceStatus?: EvidenceStatus;
  lexicalScore?: number;
  semanticScore?: number;
  graphScore?: number;
}

export type EvidenceStatus =
  | "single-source"
  | "corroborated"
  | "contested"
  | "experiment-supported"
  | "synthetic-only"
  | "insufficient";

export interface QueryResult {
  question: string;
  answer: string;
  /** Validated compiled claim IDs used by the answer. */
  citations: string[];
  matches: QueryMatch[];
  retrievalMode?: "lexical" | "hybrid";
  retrievedClaimIds?: string[];
  usage?: LlmUsage;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly configurationId?: string;
  readonly queryPrefix?: string;
  readonly passagePrefix?: string;
  embed(texts: string[], role?: "query" | "passage"): Promise<number[][]>;
}

export interface SemanticIndexResult {
  path: string;
  model: string;
  dimensions: number;
  claims: number;
  embedded: number;
  reused: number;
  removed: number;
}

export type EvidenceClueKind =
  | "gap"
  | "support"
  | "challenge"
  | "refresh"
  | "manual";

export type EvidenceClueStatus =
  | "pending"
  | "running"
  | "deferred"
  | "resolved"
  | "rejected";

export interface EvidenceClue {
  id: string;
  fingerprint: string;
  query: string;
  targetIds: string[];
  problemId: string;
  topicId: string;
  kind: EvidenceClueKind;
  priority: number;
  informationGain: number;
  semanticVector?: number[];
  status: EvidenceClueStatus;
  attempts: number;
  noNoveltyCount: number;
  mergedCount: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  nextEligibleAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  resultCount?: number;
  importedCount?: number;
}

export interface EvidenceFrontierHistoryEntry {
  fingerprint: string;
  kind: EvidenceClueKind;
  finalStatus: "resolved" | "rejected" | "expired" | "evicted";
  problemId: string;
  topicId: string;
  noNoveltyCount: number;
  updatedAt: string;
}

export interface EvidenceFrontierStatus {
  path: string;
  items: number;
  pending: number;
  running: number;
  deferred: number;
  resolved: number;
  rejected: number;
  capacity: number;
  availableCapacity: number;
  activeItems: number;
  occupancyPercent: number;
  admissionMode: "normal" | "throttled" | "critical";
  historyItems: number;
  admittedTotal: number;
  deduplicatedTotal: number;
  semanticDeduplicatedTotal: number;
  prunedTotal: number;
  compactedTotal: number;
  circuitBrokenTotal: number;
  selectedTotal: number;
}

export interface EvidenceFrontierRunResult {
  selected: EvidenceClue[];
  searches: SearchRun[];
  imported: number;
  compiled: boolean;
  indexed: boolean;
  evaluated: boolean;
  frontier: EvidenceFrontierStatus;
  usage?: LlmUsage;
}

export interface KnowledgeRefreshResult {
  path: string;
  skipped: boolean;
  reason?: string;
  scanned: number;
  enriched: number;
  retracted: number;
  changedSourceIds: string[];
  versionChangedSourceIds: string[];
  metadataChanged: boolean;
  compiled: boolean;
  indexed: boolean;
  evaluated: boolean;
  frontier: EvidenceFrontierStatus;
  usage?: LlmUsage;
}

export type RetrievalBenchmarkKind = "claim" | "contradiction" | "no-evidence";

export interface RetrievalBenchmarkCase {
  id: string;
  kind: RetrievalBenchmarkKind;
  question: string;
  expectedClaimIds: string[];
}

export interface RetrievalBenchmarkResult {
  path: string;
  cases: RetrievalBenchmarkCase[];
  usage?: LlmUsage;
}

export interface RetrievalEvaluationResult {
  path: string;
  cases: number;
  recallAt10: number;
  citationRecall: number;
  citationValidity: number;
  refusalAccuracy: number;
  contradictionRetrievalCoverage: number;
  contradictionCitationCoverage: number;
  averageLatencyMs: number;
  details: Array<{
    id: string;
    kind: RetrievalBenchmarkKind;
    retrievedClaimIds: string[];
    citations: string[];
    retrievalRecall: number;
    citationRecall: number;
    latencyMs: number;
  }>;
  usage?: LlmUsage;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmRequest {
  purpose:
    | "source-analysis"
    | "synthesis"
    | "topic-synthesis"
    | "relationship-analysis"
    | "reflection"
    | "query"
    | "screening"
    | "corroboration-plan"
    | "contradiction-adjudication"
    | "retrieval-benchmark";
  prompt: string;
  maxTokens: number;
}

export interface LlmResponse {
  text: string;
  usage?: LlmUsage;
  stopReason?: string | null;
}

/** Injectable boundary for deterministic tests and non-Anthropic deployments. */
export interface LlmProvider {
  readonly name: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export interface LintIssue {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

export interface LintResult {
  errors: LintIssue[];
  warnings: LintIssue[];
  ok: boolean;
}

export interface SearchResult {
  id: string;
  title: string;
  url: string;
  abstract?: string;
  snippet?: string;
  venue?: string;
  published?: string;
  authors?: string[];
  provider: string;
  /** All providers which contributed metadata to this normalized result. */
  providers?: string[];
  doi?: string;
  arxivId?: string;
  openAlexId?: string;
  sourceId?: string;
  versionId?: string;
  license?: string;
  openAccess?: boolean;
  oaStatus?: string;
  citationCount?: number;
  /** Provider classification only; this is not a peer-review assertion. */
  workType?: string;
  /** Explicit provider retraction status. Omission means unknown. */
  isRetracted?: boolean;
  year?: number;
  fullTextLocations?: FullTextLocation[];
  sourceProvenance?: SearchSourceProvenance[];
}

export type SearchProviderName = "crossref" | "arxiv" | "openalex";

export interface FullTextLocation {
  url: string;
  kind: "pdf" | "html" | "text" | "xml" | "landing";
  openAccess?: boolean;
  license?: string;
  source?: string;
  /** Provider ordering used only to select a safe downloadable location. */
  priority?: "arxiv" | "openalex-best" | "openalex" | "other";
}

export interface SearchSourceProvenance {
  provider: string;
  id?: string;
  url?: string;
}

export interface SearchProvider {
  readonly name: string;
  search(
    query: string,
    options: { limit: number; signal?: AbortSignal },
  ): Promise<SearchResult[]>;
}

/** OpenAlex operations used by deterministic metadata enrichment. */
export interface OpenAlexLookupProvider extends SearchProvider {
  lookupByOpenAlexId(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<SearchResult | undefined>;
  lookupByDoi(
    doi: string,
    options?: { signal?: AbortSignal },
  ): Promise<SearchResult | undefined>;
}

export interface SearchOptions {
  /** Backwards-compatible injected single provider. */
  provider?: SearchProvider;
  /**
   * Provider names for the built-in registry, or injected providers for
   * deterministic/offline callers.
   */
  providers?: SearchProviderName[] | SearchProvider[];
  limit?: number;
  importResults?: boolean;
  fetch?: typeof globalThis.fetch;
  from?: string;
  to?: string;
  /** Acquire approved open full text after screening (disabled by default). */
  fullText?: boolean;
  /** Keep metadata when an approved full-text acquisition fails. */
  onFullTextFailure?: "metadata" | "skip";
  oaOnly?: boolean;
  maxDownloads?: number;
  maxFileBytes?: number;
  /** Allow a duplicate work to upgrade these exact processed sources to full text. */
  upgradeSourceIds?: string[];
  signal?: AbortSignal;
}

export interface SearchRun {
  query: string;
  provider: string;
  providers?: string[];
  results: SearchResult[];
  imported: IngestResult[];
  errors: string[];
  fullTextDownloads?: number;
  fullTextAttempts?: number;
  usage?: LlmUsage;
}

export interface ReflectResult {
  reflectionPath: string;
  gapsPath: string;
  gaps: string[];
  observations: string[];
  usage?: LlmUsage;
}

export interface LearnResult {
  selectedGaps: string[];
  searches: SearchRun[];
  imported: number;
  compiled: boolean;
  logPath: string;
  frontier?: EvidenceFrontierStatus;
  usage?: LlmUsage;
}

export type ContradictionResolution =
  | "unresolved"
  | "context-dependent"
  | "evidence-favors-from"
  | "evidence-favors-to"
  | "insufficient-evidence";

export interface ContradictionAdjudication {
  from: string;
  to: string;
  resolution: ContradictionResolution;
  rationale: string;
  evidenceClaimIds: string[];
  evidenceNeeds: string[];
}

export interface AdjudicationResult {
  artifactPath: string;
  adjudications: ContradictionAdjudication[];
  usage?: LlmUsage;
}

export interface CorroborationTarget {
  claimId: string;
  statement: string;
  sourceId: string;
  sourceTitle: string;
  confidence: number;
  evidenceStatus: EvidenceStatus;
  independentSupportSources: number;
  summaryClaim: boolean;
  supportQuery: string;
  challengeQuery: string;
}

export interface CorroborationOptions extends SearchOptions, ServiceOptions {
  claimLimit?: number;
  /** Restrict automatic selection to the compatibility summary. */
  summaryOnly?: boolean;
  /** Explicit Claim IDs override automatic selection. */
  claimIds?: string[];
  /** Run contradiction adjudication after the evidence compile. */
  adjudicate?: boolean;
}

export interface CorroborationResult {
  planPath: string;
  targets: CorroborationTarget[];
  searches: SearchRun[];
  imported: number;
  compiled: boolean;
  before: Array<{
    claimId: string;
    confidence: number;
    evidenceStatus: EvidenceStatus;
    independentSupportSources: number;
  }>;
  after: Array<{
    claimId: string;
    confidence: number;
    evidenceStatus: EvidenceStatus;
    independentSupportSources: number;
  }>;
  adjudication?: AdjudicationResult;
  frontier?: EvidenceFrontierStatus;
  usage?: LlmUsage;
}

export interface ServiceOptions {
  root?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  /** Explicitly permits billable calls made by the default Anthropic provider. */
  approveLlm?: boolean;
  /** Maximum estimated plus actual LLM tokens allowed for this operation. */
  maxLlmTokens?: number;
  llmProvider?: LlmProvider;
  /** Injectable local embedding boundary for deterministic tests. */
  embeddingProvider?: EmbeddingProvider;
  /** Optional alternate semantic index used for parallel model evaluation. */
  semanticIndexPath?: string;
  /** Defer global topic/relationship/summary work until its source milestone. */
  deferGlobalSynthesis?: boolean;
}

export interface OpenAlexEnrichmentOptions extends ServiceOptions {
  /** Injectable provider boundary for offline tests and alternate transports. */
  openAlexProvider?: OpenAlexLookupProvider;
  limit?: number;
  dryRun?: boolean;
  /** Skip records that already contain all OpenAlex enrichment fields. */
  onlyMissing?: boolean;
  signal?: AbortSignal;
}

export interface OpenAlexEnrichmentItem {
  path: string;
  sourceId: string;
  status: "enriched" | "unchanged" | "ambiguous" | "failed" | "skipped";
  match?: "openalexId" | "doi" | "arxivId" | "title";
  message?: string;
  conflicts?: string[];
}

export interface OpenAlexEnrichmentResult {
  scanned: number;
  matchedByOpenAlexId: number;
  matchedByDoi: number;
  matchedByArxivId: number;
  matchedByTitle: number;
  enriched: number;
  unchanged: number;
  ambiguous: number;
  failed: number;
  errors: Array<{ path: string; sourceId: string; message: string }>;
  items: OpenAlexEnrichmentItem[];
}

export type RawRestoreMode = "existing" | "download" | "copy" | "none";

export interface RawManifestOrigin {
  kind: SourceProvenance["kind"];
  input: string;
  url?: string;
  provider?: string;
  storageUri?: string;
  fileName?: string;
  targetPath?: string;
  originalSha256?: string;
  sizeBytes?: number;
  capturedAt: string;
  restoreMode: RawRestoreMode;
}

export interface RawManifestEntry {
  sourceId: string;
  title: string;
  mediaType: string;
  normalizedSha256: string;
  origins: RawManifestOrigin[];
}

export interface RawManifest {
  version: 1;
  updatedAt: string;
  entries: RawManifestEntry[];
}

export interface RawManifestStatus {
  path: string;
  entries: number;
  restorable: number;
  existing: number;
  unavailable: number;
}

export interface RestoreRawItem {
  sourceId: string;
  status: "restored" | "verified" | "skipped" | "unavailable" | "error";
  path?: string;
  message: string;
}

export interface RestoreRawResult {
  manifestPath: string;
  restored: number;
  verified: number;
  skipped: number;
  unavailable: number;
  errors: number;
  items: RestoreRawItem[];
}
