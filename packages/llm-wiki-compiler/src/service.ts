import { compileWiki } from "./compile.js";
import { initWiki } from "./init.js";
import { ingest, ingestContent } from "./ingest.js";
import { learnWiki } from "./learn.js";
import { lintWiki } from "./lint.js";
import { getRawManifestStatus, loadRawManifest } from "./manifest.js";
import { queryWiki } from "./query.js";
import { reflectWiki } from "./reflect.js";
import { restoreRaw, type RestoreRawOptions } from "./restore.js";
import { searchWiki } from "./search.js";
import { getStatus } from "./status.js";
import type { IngestOptions, SearchOptions, ServiceOptions } from "./types.js";

export class WikiCompiler {
  readonly options: ServiceOptions;

  constructor(options: ServiceOptions = {}) {
    this.options = options;
  }

  init() {
    return initWiki(this.options.root);
  }

  ingest(input: string, options: IngestOptions = {}) {
    return ingest(input, { ...this.options, ...options });
  }

  ingestContent(content: string, input: string, options: IngestOptions = {}) {
    return ingestContent(content, input, { ...this.options, ...options });
  }

  compile() {
    return compileWiki(this.options);
  }

  query(question: string, limit?: number) {
    return queryWiki(question, {
      ...this.options,
      ...(limit === undefined ? {} : { limit }),
    });
  }

  lint() {
    return lintWiki(this.options);
  }

  search(query: string, options: SearchOptions = {}) {
    return searchWiki(query, { ...this.options, ...options });
  }

  reflect() {
    return reflectWiki(this.options);
  }

  learn(options: SearchOptions & { gapLimit?: number } = {}) {
    return learnWiki({ ...this.options, ...options });
  }

  status() {
    return getStatus(this.options);
  }

  manifest() {
    return loadRawManifest(this.options);
  }

  manifestStatus() {
    return getRawManifestStatus(this.options);
  }

  restoreRaw(options: RestoreRawOptions = {}) {
    return restoreRaw({ ...this.options, ...options });
  }
}
