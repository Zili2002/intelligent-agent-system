# LLM Wiki Compiler

`llmwiki` is an LLM-first, evidence-validated TypeScript compiler for local research wikis. Anthropic-backed operations require `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` and explicit `--approve-llm`; tests can inject an `LlmProvider` without approval. Source parsing, hashes, provenance, path/link validation, and quote verification remain deterministic.

New Wikis default to Claude Opus 4.8 with adaptive thinking and
`output_config.effort: high`. The official default model ID is
`claude-opus-4-8`; a configured proxy alias such as
`claude-opus-4.8[1m]` is preserved in configuration and sanitized only when a
request is sent.

## Install and build

```sh
npm install
npm run build
node dist/cli.js --help
```

The package exposes both the `llmwiki` binary and service APIs such as `WikiCompiler`, `ingest`, `compileWiki`, `queryWiki`, `lintWiki`, `searchWiki`, `reflectWiki`, and `learnWiki`.

## Commands

```text
llmwiki --root <repository> init
llmwiki --root <repository> ingest <file-or-url>
llmwiki --root <repository> --approve-llm --max-llm-tokens 10000 compile
llmwiki --root <repository> --approve-llm query <question>
llmwiki --root <repository> lint
llmwiki --root <repository> status
llmwiki --root <repository> manifest
llmwiki --root <repository> restore-raw
llmwiki --root <repository> --approve-llm search <query> [--providers arxiv,openalex,crossref] [--limit N] [--import] [--full-text]
llmwiki --root <repository> --approve-llm --max-llm-tokens 10000 reflect
llmwiki --root <repository> --approve-llm learn [--gaps N] [--limit N] [--providers arxiv,openalex,crossref] [--full-text]
llmwiki --root <repository> --approve-llm corroborate [--claim-limit N] [--claims claim-a,claim-b] [--full-text]
llmwiki --root <repository> --approve-llm adjudicate
llmwiki --root <repository> index [--force]
llmwiki --root <repository> --approve-llm benchmark-retrieval [--force]
llmwiki --root <repository> --approve-llm evaluate-retrieval [--no-answer]
llmwiki --root <repository> frontier
llmwiki --root <repository> --approve-llm frontier-run [--clues N] [--full-text]
llmwiki --root <repository> refresh [--force] [--no-recompute]
```

`init` creates `.llmwiki-config.json`, `wiki/{entities,concepts,ideas,methods,patterns,tools}`, `wiki/sources`, `sources`, `raw`, `meta/reflection`, and `schema`. Configured `wikiPath`, `sourcesPath`, and `rawPath` must be relative paths contained by the repository root.

Semantic CLI operations default to a 10,000-token total guard. Override it
with `--max-llm-tokens`; the guard lowers a request's output allowance when
needed to fit the remaining operation budget and rejects it before sending
when fewer than 128 output Tokens remain after the conservative input estimate.
Adaptive thinking Tokens are included in Anthropic `output_tokens` and are
therefore included in the same operation and Mission budget accounting.

## Evidence lifecycle

- Ingestion accepts UTF-8 text, Markdown, JSON, HTML, PDF, and HTTP(S). It normalizes content and stores SHA-256-addressed JSON artifacts in `sources/`, preserving provenance and timestamps. Empty, malformed, and unsupported inputs fail.
- Compilation splits long sources at heading/paragraph boundaries, caches each
  chunk independently, verifies every quoted claim against its chunk and
  source, and records chunk/section/offset/page locators. An excessive chunk
  count fails before any model call.
- Every accepted Claim is persisted in `meta/claims.json`; rejected Claim
  audits are stored separately. `meta/claim_graph.json` stores full-registry
  supports/contradicts/qualifies/duplicate edges.
- Claims are routed into generated `wiki/topics/*.md` shards. The 16-Claim
  limit applies only to the compatibility summary/index, never to Registry
  storage, topic pages, contradiction edges, or query retrieval.
- Querying retrieves from the complete Claim Registry, requires stable
  Registry Claim-ID citations, and can cite evidence outside the 16-item
  summary. With a current semantic index, ranking combines MiniLM similarity,
  lexical relevance, Claim-graph expansion, confidence, and contradiction-pair
  coherence; without an index, lexical retrieval remains available.
- Compilation writes auditable `meta/source_scores.json` and
  `meta/claim_confidence.json`, plus `wiki/quality/` and unresolved
  `wiki/contradictions/` pages. Source scores combine stored full-text,
  identifiers, metadata completeness, logarithmically bounded citation counts,
  OA/license, provider diversity, recency, and provenance facts. Claim
  confidence combines source quality, distinct-source support, qualifying and
  contradictory relationships. It is evidence strength—not truth probability
  or a claim of peer review. Explicit synthetic simulations receive hard caps.
- `corroborate` selects weak summary Claims (or explicit Registry Claim IDs),
  asks the LLM for separate confirming and challenging literature queries,
  searches independent providers, persists its plan, imports screened evidence,
  recompiles from caches, and reports before/after confidence. It always checks
  for previously persisted but uncompiled sources so an interrupted paid run
  can resume without losing imported evidence.
- `adjudicate` evaluates every compiled contradiction using only supplied
  immutable Claims and deterministic quality signals. It persists
  `meta/contradiction_adjudications.json` with constrained states:
  unresolved, context-dependent, evidence-favors-from, evidence-favors-to, or
  insufficient-evidence. Generated contradiction pages show the rationale,
  evidence Claim IDs, and remaining evidence needs.
- `index` runs `onnx-community/all-MiniLM-L6-v2-ONNX` locally, normalizes and
  quantizes 384-dimensional embeddings, and reuses vectors whose Claim content
  hash is unchanged. The first run downloads the public model; set
  `LLMWIKI_MODEL_CACHE` for persistent cache storage outside the Wiki.
- Embedding profiles configure ONNX dtype plus independent query/passage
  prefixes. Alternate index paths allow candidate models such as E5 to be
  built and evaluated without replacing the production index. E5 profiles
  must use `query: ` and `passage: ` prefixes; the profile is part of the
  index cache identity.
- `benchmark-retrieval` creates a fixed suite covering every summary Claim,
  every current contradiction, and at least two no-evidence questions.
  `evaluate-retrieval` reports Recall@10, citation recall/validity, refusal
  accuracy, contradiction retrieval/citation coverage, latency, and LLM usage.
- `frontier` exposes the persistent Evidence Frontier. `learn`,
  `corroborate`, version refresh, and manual lifecycle work share intent-aware
  exact fingerprints and local MiniLM semantic clusters. Stable problem/topic
  IDs enforce hierarchical quotas; information-gain ranking, 70%/90%
  watermarks, target/topic diversity, TTL, retry caps, no-novelty circuit
  breakers, bounded history compaction, and cross-process locking prevent clue
  explosion. `frontier-run` processes only the selected bounded slice.
- `refresh` checks OpenAlex metadata and exact arXiv versions at a configured
  interval. No-change runs perform no compile, embedding, or evaluation work.
  New versions become one high-priority Frontier clue; retracted,
  version-review, and superseded Claim states propagate to retrieval without
  deleting historical evidence.
- Lint checks links, generated metadata, duplicate slugs, source references, and thin generated pages.
- Reflection persists JSON and Markdown observations with validated claim/source references and prioritized search queries.
- Search fans out to the configured `crossref`, `arxiv`, and `openalex` providers and deterministically merges matching DOI, arXiv, OpenAlex, or title/year/author records before screening. The legacy `search.provider: "crossref"` config remains valid; use `search.providers` for an ordered array. Raw search makes no LLM call; imports require `--approve-llm`, an abstract or snippet, and LLM screening against focus plus the compact existing-source index.
- `enrich-openalex` enriches existing processed source **metadata only**. It never compiles, calls an LLM, or changes source content, IDs, or hashes. Matching is exact OpenAlex ID, then exact DOI, then one strict normalized title/year/first-author match; ambiguous records are reported and untouched. Use `--dry-run`, `--limit`, or `--only-missing` to control a run.
- `--full-text` is opt-in and is paired with `--oa-only` (default), `--max-downloads` (default 3), and `--max-mb` (default 100). It must never be used to bypass a paywall, login, robots restriction, or redistribution terms. Set OpenAlex credentials only with `OPENALEX_API_KEY` (and optional `OPENALEX_MAILTO`) in the environment; they are not stored in config or output. arXiv API requests have a shared minimum three-second interval.
- Learn reads structured `meta/gaps.json`, fans each query out to configured
  providers, shares one full-text download budget across all gaps, and
  recompiles once after all imports.

```json
{
  "search": {
    "providers": ["arxiv", "openalex", "crossref"],
    "resultLimit": 5,
    "oaOnly": true,
    "maxDownloads": 3,
    "maxFileBytes": 104857600
  },
  "retrieval": {
    "embeddingModel": "onnx-community/all-MiniLM-L6-v2-ONNX",
    "embeddingDtype": "q4",
    "queryPrefix": "",
    "passagePrefix": "",
    "embeddingBatchSize": 32,
    "semanticWeight": 0.55,
    "lexicalWeight": 0.25,
    "graphWeight": 0.1,
    "confidenceWeight": 0.1,
    "semanticCandidateLimit": 64
  },
  "lifecycle": {
    "maxFrontierItems": 1000,
    "maxPendingPerTarget": 20,
    "maxActivePerProblem": 20,
    "maxActivePerTopic": 200,
    "maxQueriesPerCycle": 10,
    "maxAttempts": 3,
    "clueTtlDays": 30,
    "baseCooldownMinutes": 60,
    "semanticClueDedupThreshold": 0.92,
    "highWatermarkPercent": 70,
    "criticalWatermarkPercent": 90,
    "highWatermarkMinPriority": 70,
    "criticalWatermarkMinPriority": 95,
    "noNoveltyCircuitBreaker": 3,
    "noNoveltyCooldownHours": 168,
    "maxTerminalFrontierItems": 200,
    "maxFrontierHistoryItems": 10000,
    "refreshIntervalHours": 24
  },
  "llm": {
    "chunkInputChars": 12000,
    "chunkOverlapChars": 400,
    "maxChunksPerSource": 64
  }
}
```

OpenAlex requires `OPENALEX_API_KEY`; `OPENALEX_MAILTO` is optional. Neither is
persisted or printed.

## Safe Git behavior

No command pushes. `autoCommit` defaults to `false`. When explicitly set to `true`, mutating CLI commands stage only configured wiki/source/raw paths plus `meta`, `schema`, and the config, then create a local commit. Git failures are surfaced.

## Agent integration

```ts
import { WikiCompiler } from "@intelligent-agent-system/llm-wiki-compiler";

const wiki = new WikiCompiler({ root: "/research/repository", fetch, approveLlm: true });
await wiki.ingest("notes.md");
await wiki.compile();
const result = await wiki.query("What evidence discusses retrieval?");
```

Search providers implement:

```ts
interface SearchProvider {
  readonly name: string;
  search(
    query: string,
    options: { limit: number; signal?: AbortSignal },
  ): Promise<SearchResult[]>;
}
```

This allows deterministic offline providers in autonomous agents and tests.
Autonomous-agent integrations must set their separate `wikiLlm.approved` boundary;
experiment-design approvals and experiment budgets never authorize Wiki LLM calls.
`wikiLlm.maxTokensPerSync` caps each synchronization, and actual Wiki usage is
persisted against the Mission LLM token budget.

Semantic operations require a non-empty `researchFocus`; `init` supplies a generic
default for new wikis, while legacy configs remain parseable until a semantic
operation is requested. Source pages render media type, ingestion time, hash, and
the complete provenance history.

## Raw source migration

Every ingestion updates `raw/manifest.json` with:

- processed source ID and normalized SHA-256
- original byte hash and size when available
- source URL, local path, provider, or external storage URI
- a safe relative restoration path
- whether the source is downloadable, copyable, already present, or unavailable

Associate a local file with durable storage while ingesting:

```bash
llmwiki ingest paper.pdf \
  --storage-uri "https://storage.example/paper.pdf"
```

On a new device:

```bash
llmwiki manifest
llmwiki restore-raw
llmwiki --approve-llm compile
llmwiki lint
```

Restoration verifies the original SHA-256 before writing. Changed downloads,
oversized files, and paths escaping `raw/` are rejected. Search metadata and
experiment-generated evidence remain explicitly marked unavailable because
they have no original binary source.

Do not put credentials or long-lived signed query parameters in
`--storage-uri`; the manifest is intended to be committed. Use a stable object
identifier, Git LFS, or a separately authenticated restoration workflow.
