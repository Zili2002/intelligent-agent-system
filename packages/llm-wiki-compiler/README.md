# LLM Wiki Compiler

`llmwiki` is a deterministic, evidence-first TypeScript compiler for local research wikis. It does not require Anthropic or other paid-model credentials. Summaries are extractive, concepts are lexical-frequency keywords, and query answers quote ranked local evidence with file citations.

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
llmwiki --root <repository> compile
llmwiki --root <repository> query <question>
llmwiki --root <repository> lint
llmwiki --root <repository> status
llmwiki --root <repository> search <query> [--limit N] [--import]
llmwiki --root <repository> reflect
llmwiki --root <repository> learn [--gaps N] [--limit N]
```

`init` creates `.llmwiki-config.json`, `wiki/{entities,concepts,ideas,methods,patterns,tools}`, `wiki/sources`, `sources`, `raw`, `meta/reflection`, and `schema`. Configured `wikiPath`, `sourcesPath`, and `rawPath` must be relative paths contained by the repository root.

## Evidence lifecycle

- Ingestion accepts UTF-8 text, Markdown, JSON, HTML, PDF, and HTTP(S). It normalizes content and stores SHA-256-addressed JSON artifacts in `sources/`, preserving provenance and timestamps. Empty, malformed, and unsupported inputs fail.
- Compilation creates source and concept pages with generated frontmatter/provenance, preserves text after its generated marker, rebuilds `wiki/index.md`, appends `wiki/log.md`, and writes graph, capability, and gap artifacts under `meta/`.
- Querying uses lexical term overlap. If there is no matching evidence, it explicitly returns no answer.
- Lint checks links, generated metadata, duplicate slugs, source references, and thin generated pages.
- Reflection reports structural/lexical heuristics for thin pages, orphans, unsupported claims, and possible contradictions. These signals are explicitly not semantic verification.
- Search uses the public Crossref API by default. Results are only imported when `--import` is supplied, and only if they contain an abstract or snippet.
- Learn reads `meta/gaps.md`, searches selected gaps, imports actual evidence-bearing results, recompiles only when imports occur, and records exact counts/errors in `meta/learning-log.md`.

## Safe Git behavior

No command pushes. `autoCommit` defaults to `false`. When explicitly set to `true`, mutating CLI commands stage only configured wiki/source/raw paths plus `meta`, `schema`, and the config, then create a local commit. Git failures are surfaced.

## Agent integration

```ts
import { WikiCompiler } from "@intelligent-agent-system/llm-wiki-compiler";

const wiki = new WikiCompiler({ root: "/research/repository", fetch });
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
