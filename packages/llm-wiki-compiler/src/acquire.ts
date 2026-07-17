import { acquireFullText, type FullTextAcquisition } from "./full-text.js";
import type { SearchResult, ServiceOptions } from "./types.js";

export interface AcquireSearchResultOptions extends ServiceOptions {
  approveNetwork?: boolean;
  oaOnly?: boolean;
  maxFileBytes?: number;
  signal?: AbortSignal;
}

export async function acquireSearchResult(
  result: SearchResult,
  options: AcquireSearchResultOptions = {},
): Promise<FullTextAcquisition> {
  if (options.approveNetwork !== true) {
    throw new Error(
      "Full-text acquisition requires explicit network approval (approveNetwork: true)",
    );
  }
  const maxFileBytes = options.maxFileBytes ?? 100 * 1024 * 1024;
  if (
    !Number.isFinite(maxFileBytes) ||
    !Number.isInteger(maxFileBytes) ||
    maxFileBytes < 1
  ) {
    throw new Error("maxFileBytes must be a positive finite integer");
  }
  return acquireFullText(result, {
    ...(options.root ? { root: options.root } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    oaOnly: options.oaOnly ?? true,
    maxFileBytes,
  });
}
