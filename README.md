# Intelligent Agent System

A mission-driven research agent and Git-versioned knowledge compiler.

The system runs bounded exploration cycles, executes reviewed experiments,
analyzes structured results, reflects on verified findings, and records
knowledge in a separate Markdown wiki.

## Packages

- `packages/autonomous-agent` — mission parsing, hypothesis generation,
  experiment design, sandbox execution, analysis, reflection, decisions,
  budgets, approval queues, continuous scheduling, retries, health checks,
  run history, and durable CLI state.
- `packages/llm-wiki-compiler` — Crossref/arXiv/OpenAlex search, open-full-text
  acquisition, provenance and deduplication, chunked LLM evidence synthesis,
  complete Claim Registry, deterministic source/Claim quality metadata,
  topic/contradiction graph, cited query, Claim-targeted corroboration,
  evidence-grounded contradiction adjudication, local semantic retrieval,
  bounded evidence-frontier scheduling, incremental source/version/retraction
  refresh, fixed retrieval evaluation, reflection, and active learning.
- `packages/shared` — atomic `.agent-state.json` checkpoints and explicit,
  branch-aware Git handoff utilities.

The companion knowledge repository is
[`Zili2002/my-research-wiki`](https://github.com/Zili2002/my-research-wiki).

## Requirements

- Node.js 20 or later
- Git
- Docker when using the Docker experiment sandbox
- An Anthropic API key or auth token only when `analysis.mode` is `llm` or
  hybrid LLM reasoning is desired

Tests and the offline workflow do not require paid credentials or network
search.

## Install

This repository is configured to use the required internal npm registry:

```bash
npm install
npm run build
npm test
npm run lint
```

## Local autonomous-agent example

```bash
# Build first
npm run build

# Initialize an isolated workspace
node packages/autonomous-agent/dist/cli.js --root ./agent-workspace init

# Start a mission
node packages/autonomous-agent/dist/cli.js \
  --root ./agent-workspace \
  mission-start ./examples/missions/example-mission.md

# Run one deterministic cycle through the local Node sandbox
node packages/autonomous-agent/dist/cli.js \
  --root ./agent-workspace \
  explore <mission-id> --sandbox local --offline --approve
```

Use `run` for bounded continuous cycles and `experiment-resume --approve` for
review-gated or interrupted experiments.

For unattended bounded scheduling:

```bash
node packages/autonomous-agent/dist/cli.js \
  --root ./agent-workspace \
  daemon <mission-id> --offline --sandbox docker \
  --interval 300 --max-duration 86400
```

Use `approvals`, `approval-approve`, `approval-reject`, `runs`, `history`, and
`health` to operate and inspect the daemon.

## Knowledge workflow

Build the `llmwiki` binary, then run it against the sibling wiki repository:

```bash
llmwiki init
llmwiki ingest raw/example.md
llmwiki --approve-llm --max-llm-tokens 10000 compile
llmwiki --approve-llm query "What evidence exists for this topic?"
llmwiki lint
llmwiki --approve-llm --max-llm-tokens 10000 reflect
llmwiki search "autonomous agent evaluation"
llmwiki --approve-llm search "autonomous agent evaluation" --providers arxiv,openalex,crossref --import
llmwiki --approve-llm search "autonomous agent evaluation" --import
llmwiki --approve-llm learn \
  --providers arxiv,openalex,crossref \
  --full-text --max-downloads 3
llmwiki --approve-llm corroborate \
  --providers arxiv,openalex,crossref \
  --full-text --claim-limit 3
llmwiki --approve-llm adjudicate
llmwiki index
llmwiki --approve-llm benchmark-retrieval
llmwiki --approve-llm evaluate-retrieval
llmwiki frontier
llmwiki --approve-llm frontier-run --full-text
llmwiki refresh
llmwiki status
```

The compiler preserves source provenance and returns no-evidence rather than
inventing an answer when nothing relevant is indexed.

`raw/manifest.json` records reconstructable source locations and original
hashes. On a new device, use `llmwiki manifest` and `llmwiki restore-raw`
before recompiling. Large binaries should live in Git LFS or external object
storage rather than normal Git history.

Literature search defaults to Crossref but supports `arxiv` and `openalex`
provider fan-out. Full text is opt-in and OA-only by default; it never
bypasses paywalls, login, robots restrictions, or redistribution terms.

`llmwiki index` builds an incremental, quantized local MiniLM index. The model
is downloaded once and cached locally; Claim text is not sent to a remote
embedding API. Hybrid query combines semantic similarity, lexical overlap,
Claim-graph neighbors, confidence, and contradiction pairs. Fixed benchmark
evaluation measures Recall@10, citation recall/validity, refusal behavior,
contradiction coverage, latency, and Token usage.

Embedding model changes are evaluated through isolated profile-specific
indexes. Model, dtype, query prefix, and passage prefix are part of the index
identity, so multilingual E5 candidates cannot silently contaminate the
production MiniLM vectors.

Repeated autonomous searches are admitted to a persistent Evidence Frontier.
Frontier v2 uses local MiniLM embeddings to merge semantic paraphrases while
keeping supporting and challenging searches separate. Stable problem/topic
IDs, hierarchical quotas, information-gain scheduling, 70%/90% watermarks,
no-novelty circuit breakers, bounded history compaction, and a cross-process
lock keep both stored clues and executed work bounded. `refresh` checks
OpenAlex metadata and exact arXiv versions, propagates retractions and
supersession, and performs no compile/index/evaluation work when nothing
changed.

## State and Git behavior

- Mission and experiment files are written atomically.
- `.agent-state.json` provides cross-session context.
- Onboarding is local-only unless `--pull` or `--pull-wiki` is supplied.
- Handoff checkpoints locally unless commit/push flags are explicitly
  supplied.
- Pulls use fast-forward-only behavior and refuse dirty repositories.
- Automatic external publication is not part of local validation.

## Safety

- Generated experiment code is statically checked before execution.
- Docker execution restricts resources, capabilities, processes, filesystem,
  and network access.
- Local execution is allowlisted, receives a scrubbed environment, and always
  requires explicit approval because it is not filesystem-isolated.
- Mission budgets and iteration limits stop autonomous continuation.
- LLM token pricing is configurable because model pricing is not assumed.
- Active-search and reflection output records whether evidence is retrieved or
  only heuristically inferred.

## Documentation

- [Architecture](./docs/architecture.md)
- [Deployment](./docs/deployment.md)
- [Mission format](./docs/mission-format.md)
- [Multi-device state](./docs/multi-device-sync.md)
- [Self-evolving knowledge design](./docs/self-evolution-knowledge-base-design.md)

## License

MIT
