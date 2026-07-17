import type {
  LiteratureMetadata,
  LlmProvider,
  LlmUsage,
  SearchProvider,
  SearchProviderName,
  SearchResult,
} from "@intelligent-agent-system/llm-wiki-compiler";

export const READER_SCHEMA_VERSION = 1;

export type ReadingStatus =
  | "unread"
  | "queued"
  | "reading"
  | "read"
  | "revisit"
  | "dismissed";

export type ReadingRecommendation =
  | "priority"
  | "deep-read"
  | "skim"
  | "archive"
  | "manual-review";

export type ReviewLevel = "fast" | "standard" | "deep";

export type PaperType =
  | "empirical"
  | "theoretical"
  | "survey"
  | "systems"
  | "reproduction"
  | "short"
  | "other";

export type ReadingMode =
  | "quick-scan"
  | "guided-read"
  | "deep-dive"
  | "compare"
  | "extract";

export interface WeightedTerm {
  term: string;
  weight: number;
}

export interface PaperDiscovery {
  subscriptionId?: string;
  query: string;
  provider: string;
  runId: string;
  discoveredAt: string;
}

export interface PaperPassport {
  version: 1;
  id: string;
  canonicalKey: string;
  sourceIds: string[];
  metadata: LiteratureMetadata;
  candidate?: SearchResult;
  discovery: PaperDiscovery[];
  acquisition: {
    status: "metadata-only" | "available" | "failed";
    fullTextSourceId?: string;
    failureReason?: string;
    lastAttemptError?: string;
    lastAttemptAt?: string;
  };
  triage?: {
    relevanceScore: number;
    confidence: number;
    difficultyEstimate?: number;
    recommendation: ReadingRecommendation;
    reasons: string[];
    profileVersion: string;
    policyVersion: string;
  };
  reading: {
    status: ReadingStatus;
    priority: number;
    progress?: number;
    startedAt?: string;
    completedAt?: string;
    userTags: string[];
    userRating?: number;
    personalValue?: number;
    understandingScore?: number;
    notePath?: string;
  };
  reviewIds: string[];
  knowledge: {
    compiled: boolean;
    claimIds: string[];
    wikiPaths: string[];
    compiledAt?: string;
  };
  lifecycle: {
    latestVersionId?: string;
    reviewStale: boolean;
    retracted: boolean;
    supersededBy?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceAnchor {
  sourceId: string;
  quote: string;
  page?: number;
  section?: string;
  start?: number;
  end?: number;
}

export interface DimensionAssessment {
  state: "assessed" | "unknown" | "not-applicable";
  score?: number;
  confidence: number;
  rationale: string;
  evidence: EvidenceAnchor[];
}

export interface ReviewIntegrityIssue {
  type: "evidence" | "citation" | "temporal" | "retraction" | "coverage";
  severity: "blocking" | "high-warning" | "medium-warning" | "advisory";
  message: string;
  evidence: EvidenceAnchor[];
}

export interface ReviewChallenge {
  text: string;
  severity: "high" | "medium" | "low";
  evidence: EvidenceAnchor[];
}

export interface PaperReview {
  version: 1;
  id: string;
  paperId: string;
  sourceId: string;
  sourceVersion?: string;
  level: ReviewLevel;
  paperType: PaperType;
  coverage: {
    fullText: boolean;
    sections: string[];
    pages: number[];
    coverageScore: number;
  };
  dimensions: {
    importance: DimensionAssessment;
    novelty: DimensionAssessment;
    methodology: DimensionAssessment;
    experiments: DimensionAssessment;
    reproducibility: DimensionAssessment;
    writing: DimensionAssessment;
    theory: DimensionAssessment;
    completeness?: DimensionAssessment;
    organization?: DimensionAssessment;
  };
  scientificQuality?: number;
  evidenceConfidence: number;
  personalRelevance: number;
  recommendation: Exclude<ReadingRecommendation, "manual-review">;
  estimatedReadMinutes?: number;
  strengths: string[];
  weaknesses: string[];
  criticalIssues: string[];
  prerequisites: string[];
  readingRoute: string[];
  adversarialChallenges: ReviewChallenge[];
  unresolvedChallenges: string[];
  integrityIssues?: ReviewIntegrityIssue[];
  model: string;
  promptVersion: string;
  usage?: LlmUsage;
  createdAt: string;
}

export interface ReadingQuestion {
  question: string;
  answer?: string;
  citations: EvidenceAnchor[];
}

export interface ReadingSession {
  version: 1;
  id: string;
  paperId: string;
  sourceVersion?: string;
  mode: ReadingMode;
  intent: "exploratory" | "goal-oriented";
  status: "active" | "paused" | "completed";
  checkpoints: Array<{
    level: 1 | 2 | 3;
    completedAt?: string;
    userConfirmed: boolean;
  }>;
  progress: {
    page?: number;
    section?: string;
    percent?: number;
  };
  questions: ReadingQuestion[];
  selfAssessment?: {
    understanding: number;
    unresolvedQuestions: string[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface PaperAnnotation {
  version: 1;
  id: string;
  paperId: string;
  sourceVersion?: string;
  page?: number;
  selectedQuote?: string;
  drawingDataUrl?: string;
  voiceTranscript?: string;
  note: string;
  status: "active" | "needs-remap";
  createdAt: string;
  updatedAt: string;
}

export interface ReaderNavigationGraph {
  version: 1;
  generatedAt: string;
  nodes: Array<{
    id: string;
    type: "paper" | "claim" | "topic" | "prerequisite";
    label: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    type:
      | "contains"
      | "supports"
      | "contradicts"
      | "qualifies"
      | "duplicate"
      | "requires";
  }>;
}

export interface ReadingAnalytics {
  version: 1;
  generatedAt: string;
  papers: number;
  completedPapers: number;
  sessions: number;
  completedSessions: number;
  sessionsByMode: Record<ReadingMode, number>;
  averageExplicitUnderstanding?: number;
  unresolvedQuestions: string[];
}

export interface DialogueHealth {
  version: 1;
  generatedAt: string;
  signals: Array<{
    sessionId: string;
    type:
      | "persistent-agreement"
      | "conflict-avoidance"
      | "premature-convergence";
    message: string;
  }>;
}

export interface RetentionCheck {
  version: 1;
  id: string;
  paperId: string;
  status: "pending" | "completed";
  dueAt: string;
  items: Array<{
    question: string;
    selfScore?: number;
  }>;
  score?: number;
  createdAt: string;
  completedAt?: string;
}

export interface ReasoningPattern {
  id: string;
  title: string;
  path: string;
}

export interface SurveyPlan {
  version: 1;
  id: string;
  question: string;
  generatedAt: string;
  paperIds: string[];
  topicIds: string[];
  claimIds: string[];
  gaps: string[];
  markdownPath: string;
  jsonPath: string;
}

export interface ReadingCheckpointInput {
  level: 1 | 2 | 3;
  userConfirmed: boolean;
  page?: number;
  section?: string;
  percent?: number;
  understanding?: number;
  unresolvedQuestions?: string[];
}

export interface ResearchProfile {
  version: 1;
  profileVersion: string;
  explicit: {
    topics: WeightedTerm[];
    methods: WeightedTerm[];
    followedAuthors: string[];
    excludedTopics: string[];
    preferredLanguages: string[];
    expertiseByTopic: WeightedTerm[];
  };
  learned: {
    topics: WeightedTerm[];
    methods: WeightedTerm[];
    recentFocus: WeightedTerm[];
    strongAreas: WeightedTerm[];
    weakAreas: WeightedTerm[];
    questionTopics: WeightedTerm[];
    confidence: number;
    sampleCount: number;
  };
  updatedAt: string;
}

export type SubscriptionKind = "query" | "category" | "author" | "paper";

export interface ReaderSubscription {
  version: 1;
  id: string;
  name: string;
  enabled: boolean;
  kind: SubscriptionKind;
  query: string;
  weight: number;
  tags: string[];
  preferredLanguages: string[];
  providers?: SearchProviderName[];
  createdAt: string;
  updatedAt: string;
}

export interface ReaderSubscriptions {
  version: 1;
  items: ReaderSubscription[];
}

export interface TriageResult {
  relevanceScore: number;
  confidence: number;
  difficultyEstimate?: number;
  recommendation: ReadingRecommendation;
  reasons: string[];
  signals: {
    profileSimilarity: number;
    keywordMatch: number;
    authorMatch: number;
  };
  mode: "deterministic" | "deterministic+llm";
}

export interface ReaderTrackingRun {
  version: 1;
  id: string;
  type: "tracking";
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  subscriptions: number;
  searches: number;
  candidates: number;
  created: number;
  updated: number;
  errors: string[];
  reportPath?: string;
  reportJsonPath?: string;
  usage?: LlmUsage;
}

export type FeedbackType =
  | "quality-rating"
  | "personal-value"
  | "recommendation-feedback"
  | "reading-completed"
  | "reading-abandoned"
  | "question-topic";

export interface ReaderFeedbackEvent {
  version: 1;
  id: string;
  paperId: string;
  type: FeedbackType;
  explicit: boolean;
  value?: number;
  accepted?: boolean;
  topics?: string[];
  comment?: string;
  recommendation?: ReadingRecommendation;
  createdAt: string;
}

export interface CalibrationEvaluation {
  version: 1;
  status: "uncalibrated" | "calibrated";
  generatedAt: string;
  explicitSamples: number;
  objectiveSamples: number;
  preferenceSamples: number;
  objective?: {
    meanAbsoluteError: number;
    falsePositiveRate: number;
    falseNegativeRate: number;
  };
  preference?: {
    meanAbsoluteError: number;
    recommendationAgreement: number;
  };
}

export type ReaderApprovalType =
  | "network"
  | "llm"
  | "full-text"
  | "compile"
  | "notification";

export interface ReaderApprovalRequest {
  version: 1;
  id: string;
  type: ReaderApprovalType;
  status: "pending" | "approved" | "rejected" | "consumed";
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  rejectionReason?: string;
}

export interface ReaderDaemonRecord {
  version: 1;
  id: string;
  status: "running" | "completed" | "stopped" | "failed" | "waiting-approval";
  startedAt: string;
  completedAt?: string;
  cycles: number;
  attempts: number;
  trackingRunIds: string[];
  error?: string;
}

export interface ReaderDaemonOptions extends ReaderTrackOptions {
  intervalMs: number;
  maxDurationMs: number;
  maxCycles: number;
  retry: {
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
  };
  signal?: AbortSignal;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  clock?: () => number;
  trackStep?: (
    config: ResolvedReaderConfig,
    options: ReaderTrackOptions,
  ) => Promise<ReaderTrackResult>;
}

export interface ReaderHealth {
  ok: boolean;
  root: string;
  schemaVersion: number;
  trackingEnabled: boolean;
  schedulerEnabled: boolean;
  anthropicConfigured: boolean;
  openAlexConfigured: boolean;
  pendingApprovals: number;
  interruptedRuns: number;
  recentFailures: number;
  metrics: {
    runs: number;
    completedRuns: number;
    averageDurationMs: number;
    p95DurationMs: number;
    candidates: number;
    created: number;
    updated: number;
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ReaderTrackOptions {
  approveNetwork?: boolean;
  approveLlm?: boolean;
  providers?: SearchProviderName[] | SearchProvider[];
  llmProvider?: LlmProvider;
  maxLlmTokens?: number;
  limit?: number;
  now?: Date;
}

export interface ReaderAcquireOptions {
  approveNetwork?: boolean;
  fetch?: typeof globalThis.fetch;
  oaOnly?: boolean;
  maxFileBytes?: number;
}

export interface ReaderReviewOptions {
  level: ReviewLevel;
  approveLlm?: boolean;
  llmProvider?: LlmProvider;
  maxLlmTokens?: number;
  adversarial?: boolean;
  auditCitations?: boolean;
  approveNetwork?: boolean;
  citationProviders?: SearchProviderName[] | SearchProvider[];
  fetch?: typeof globalThis.fetch;
  now?: Date;
}

export interface ReaderQuestionOptions {
  approveLlm?: boolean;
  llmProvider?: LlmProvider;
  maxLlmTokens?: number;
}

export interface ReaderExtractOptions {
  approveLlm?: boolean;
  llmProvider?: LlmProvider;
  maxLlmTokens?: number;
  recompile?: boolean;
  now?: Date;
}

export interface PaperComparison {
  version: 1;
  id: string;
  paperIds: string[];
  summary: string;
  differences: Array<{
    topic: string;
    analysis: string;
    evidence: EvidenceAnchor[];
  }>;
  model: string;
  usage?: LlmUsage;
  createdAt: string;
  markdownPath: string;
  jsonPath: string;
}

export interface CitationAuditItem {
  kind: "doi" | "arxiv";
  value: string;
  status: "verified" | "unresolvable" | "suspicious" | "retracted";
  providers: string[];
  evidence: EvidenceAnchor;
}

export interface ReaderTrackResult {
  run: ReaderTrackingRun;
  papers: PaperPassport[];
  candidates: SearchResult[];
}

export interface ReaderMigrationState {
  version: 1;
  schemaVersion: number;
  applied: Array<{
    id: string;
    appliedAt: string;
  }>;
}

export interface ReaderConfig {
  version: 1;
  metaPath: string;
  reportsPath: string;
  wikiPath: string;
  tracking: {
    enabled: boolean;
    lookbackDays: number;
    maxCandidatesPerRun: number;
    maxLlmCandidatesPerRun: number;
    maxFullTextDownloadsPerRun: number;
    concurrency: number;
    preferredLanguages: string[];
  };
  triage: {
    semanticWeight: number;
    keywordWeight: number;
    authorWeight: number;
    minimumRelevance: number;
  };
  review: {
    autoFastReview: boolean;
    autoStandardReview: boolean;
    requireFullTextForStandard: boolean;
    adversarialPass: boolean;
    citationIntegrity: boolean;
    temporalIntegrity: boolean;
    maxTokensPerRun: number;
  };
  reading: {
    requireLevelConfirmation: boolean;
    autoCompileOnComplete: boolean;
    retentionChecksEnabled: boolean;
  };
  profile: {
    learningEnabled: boolean;
    minimumExplicitFeedback: number;
    maximumLearnedWeightChange: number;
  };
  scheduler: {
    enabled: boolean;
    cron?: string;
    timezone: string;
    intervalSeconds: number;
    jitterSeconds: number;
    staleLockSeconds: number;
  };
}

export interface ResolvedReaderConfig extends ReaderConfig {
  root: string;
  configPath: string;
  metaDir: string;
  papersDir: string;
  reviewsDir: string;
  sessionsDir: string;
  annotationsDir: string;
  notesDir: string;
  retentionDir: string;
  patternsDir: string;
  approvalsDir: string;
  calibrationDir: string;
  runsDir: string;
  migrationsDir: string;
  reportsDir: string;
  dailyReportsDir: string;
  weeklyReportsDir: string;
  trendsReportsDir: string;
  surveyReportsDir: string;
  wikiDir: string;
}

export interface ReaderServiceOptions {
  root?: string;
}

export interface ReaderStatus {
  root: string;
  configPath: string;
  schemaVersion: number;
  subscriptions: number;
  papers: number;
  reviews: number;
  sessions: number;
  runs: number;
  readingByStatus: Record<ReadingStatus, number>;
}

export interface ReaderInitResult {
  root: string;
  configPath: string;
  createdConfig: boolean;
  status: ReaderStatus;
}
