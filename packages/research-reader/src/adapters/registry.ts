import type { LiteratureAdapter, LiteratureAdapterContract } from "./types.js";

export class LiteratureAdapterRegistry {
  readonly #adapters = new Map<string, LiteratureAdapter>();

  register(adapter: LiteratureAdapter): void {
    if (!/^[a-z][a-z0-9-]*$/.test(adapter.name)) {
      throw new Error(`Invalid adapter name: ${adapter.name}`);
    }
    if (this.#adapters.has(adapter.name)) {
      throw new Error(`Adapter already registered: ${adapter.name}`);
    }
    this.#adapters.set(adapter.name, adapter);
  }

  get(name: string): LiteratureAdapter {
    const adapter = this.#adapters.get(name);
    if (!adapter) throw new Error(`Unknown literature adapter: ${name}`);
    return adapter;
  }

  list(): string[] {
    return [...this.#adapters.keys()].sort();
  }
}

export const literatureAdapterRegistry = new LiteratureAdapterRegistry();

export const LITERATURE_ADAPTER_CONTRACT: LiteratureAdapterContract = {
  version: 1,
  fields: {
    metadata: ["id", "title", "url", "provider"],
    optional: [
      "doi",
      "arxivId",
      "openAlexId",
      "authors",
      "published",
      "year",
      "venue",
      "license",
      "openAccess",
    ],
  },
  providers: ["crossref", "arxiv", "openalex"],
};
