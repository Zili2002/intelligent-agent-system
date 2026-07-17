import type {
  LiteratureMetadata,
  SearchProvider,
  SearchProviderName,
} from "@intelligent-agent-system/llm-wiki-compiler";

export interface AdapterInput {
  source: string;
  root: string;
  approveNetwork?: boolean;
  fetch?: typeof globalThis.fetch;
  limit?: number;
}

export interface AdapterItem {
  metadata: LiteratureMetadata;
  filePath?: string;
  content?: string;
  mediaType?: string;
  evidenceKind?: "full-text" | "abstract" | "note";
  note?: string;
}

export interface AdapterResult {
  items: AdapterItem[];
  warnings: string[];
}

export interface LiteratureAdapter {
  readonly name: string;
  import(input: AdapterInput): Promise<AdapterResult>;
}

export interface AdapterRunOptions {
  approveNetwork?: boolean;
  fetch?: typeof globalThis.fetch;
  limit?: number;
}

export interface AdapterRunResult {
  adapter: string;
  imported: number;
  createdPapers: number;
  updatedPapers: number;
  paperIds: string[];
  warnings: string[];
}

export interface LiteratureAdapterContract {
  version: 1;
  fields: {
    metadata: string[];
    optional: string[];
  };
  providers: Array<SearchProviderName | SearchProvider["name"]>;
}
