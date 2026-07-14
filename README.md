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
- `packages/llm-wiki-compiler` — source ingestion, provenance and
  deduplication, deterministic compilation, cited query, lint, reflection, and
  active search/learning.
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
llmwiki compile
llmwiki query "What evidence exists for this topic?"
llmwiki lint
llmwiki reflect
llmwiki search "autonomous agent evaluation"
llmwiki learn
llmwiki status
```

The compiler preserves source provenance and returns no-evidence rather than
inventing an answer when nothing relevant is indexed.

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
