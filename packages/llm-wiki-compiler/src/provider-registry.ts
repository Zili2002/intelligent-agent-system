import { ArxivProvider, OpenAlexProvider } from "./providers.js";
import type { SearchProvider, SearchProviderName } from "./types.js";

export type SearchProviderFactory = (
  fetcher?: typeof globalThis.fetch,
) => SearchProvider;

/**
 * Central registry for built-in literature providers. It permits applications
 * to replace a provider with an offline implementation without changing
 * configuration parsing or result normalization.
 */
export class SearchProviderRegistry {
  #factories = new Map<SearchProviderName, SearchProviderFactory>();

  register(name: SearchProviderName, factory: SearchProviderFactory): void {
    this.#factories.set(name, factory);
  }

  create(
    name: SearchProviderName,
    fetcher?: typeof globalThis.fetch,
  ): SearchProvider {
    const factory = this.#factories.get(name);
    if (!factory) throw new Error(`Search provider is not registered: ${name}`);
    return factory(fetcher);
  }

  names(): SearchProviderName[] {
    return [...this.#factories.keys()];
  }
}

export const searchProviderRegistry = new SearchProviderRegistry();
searchProviderRegistry.register(
  "arxiv",
  (fetcher) => new ArxivProvider(fetcher ? { fetch: fetcher } : {}),
);
searchProviderRegistry.register(
  "openalex",
  (fetcher) => new OpenAlexProvider(fetcher ? { fetch: fetcher } : {}),
);
