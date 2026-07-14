export interface WikiConfig {
  wikiPath: string;
  sourcesPath: string;
  rawPath: string;
  autoCommit: boolean;
  search: {
    provider: "crossref";
    resultLimit: number;
  };
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
  provenance: SourceProvenance;
  provenanceHistory: SourceProvenance[];
  ingestedAt: string;
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
}

export interface QueryMatch {
  path: string;
  title: string;
  score: number;
  excerpt: string;
}

export interface QueryResult {
  question: string;
  answer: string;
  matches: QueryMatch[];
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
}

export interface SearchProvider {
  readonly name: string;
  search(
    query: string,
    options: { limit: number; signal?: AbortSignal },
  ): Promise<SearchResult[]>;
}

export interface SearchOptions {
  provider?: SearchProvider;
  limit?: number;
  importResults?: boolean;
  fetch?: typeof globalThis.fetch;
}

export interface SearchRun {
  query: string;
  provider: string;
  results: SearchResult[];
  imported: IngestResult[];
  errors: string[];
}

export interface ReflectResult {
  reflectionPath: string;
  gapsPath: string;
  gaps: string[];
  observations: string[];
}

export interface LearnResult {
  selectedGaps: string[];
  searches: SearchRun[];
  imported: number;
  compiled: boolean;
  logPath: string;
}

export interface ServiceOptions {
  root?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
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
