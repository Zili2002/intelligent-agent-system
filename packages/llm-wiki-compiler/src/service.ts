import { adjudicateWiki } from "./adjudicate.js";
import { compileWiki } from "./compile.js";
import { corroborateWiki } from "./corroborate.js";
import { enrichOpenAlex } from "./enrich-openalex.js";
import { createRetrievalBenchmark, evaluateRetrieval } from "./evaluate.js";
import { initWiki } from "./init.js";
import { ingest, ingestContent } from "./ingest.js";
import { learnWiki } from "./learn.js";
import { lintWiki } from "./lint.js";
import { getRawManifestStatus, loadRawManifest } from "./manifest.js";
import { queryWiki } from "./query.js";
import { refreshKnowledge, type KnowledgeRefreshOptions } from "./refresh.js";
import { reflectWiki } from "./reflect.js";
import { restoreRaw, type RestoreRawOptions } from "./restore.js";
import { getEvidenceFrontierStatus } from "./frontier.js";
import { runEvidenceFrontier } from "./frontier-run.js";
import { searchWiki } from "./search.js";
import { buildSemanticIndex } from "./semantic-index.js";
import { getStatus } from "./status.js";
import type {
  IngestOptions,
  CorroborationOptions,
  OpenAlexEnrichmentOptions,
  SearchOptions,
  ServiceOptions,
} from "./types.js";

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

  indexSemantic(force = false) {
    return buildSemanticIndex({ ...this.options, force });
  }

  benchmarkRetrieval(force = false) {
    return createRetrievalBenchmark({ ...this.options, force });
  }

  evaluateRetrieval(answer = true) {
    return evaluateRetrieval({ ...this.options, answer });
  }

  frontierStatus() {
    return getEvidenceFrontierStatus(this.options);
  }

  runFrontier(options: SearchOptions & { clueLimit?: number } = {}) {
    return runEvidenceFrontier({ ...this.options, ...options });
  }

  refresh(options: Omit<KnowledgeRefreshOptions, "root"> = {}) {
    return refreshKnowledge({ ...this.options, ...options });
  }

  corroborate(options: Omit<CorroborationOptions, "root"> = {}) {
    return corroborateWiki({ ...this.options, ...options });
  }

  adjudicate() {
    return adjudicateWiki(this.options);
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

  enrichOpenAlex(options: Omit<OpenAlexEnrichmentOptions, "root"> = {}) {
    return enrichOpenAlex({ ...this.options, ...options });
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
