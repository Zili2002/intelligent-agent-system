# Architecture

## Repositories

### `intelligent-agent-system`

Contains runtime code, Mission and experiment state, synchronization helpers,
tests, CI, and Docker packaging.

### `my-research-wiki`

Contains raw evidence, normalized source artifacts, generated Markdown,
knowledge graph metadata, reflection output, and quality rules.

## Packages

```text
autonomous-agent
  ├─ mission parser and atomic state
  ├─ orient / hypothesize / design
  ├─ safety and approval gate
  ├─ Docker/local execution
  ├─ analyze / reflect / decide
  ├─ mission lock / retry / recovery / scheduler
  ├─ run history / health / approval queue
  └─ wiki evidence bridge

llm-wiki-compiler
  ├─ config and initialization
  ├─ ingest and SHA-256 deduplication
  ├─ deterministic compile and graph
  ├─ cited lexical query
  ├─ lint and heuristic reflection
  └─ Crossref search and bounded learning

shared
  ├─ AgentState types
  ├─ atomic locked checkpoints
  ├─ explicit ff-only onboarding
  └─ explicit commit/push handoff
```

## Autonomous cycle

```text
Mission
  ↓
Orient → Hypothesize → Design
  ↓
Safety policy → Approval policy
  ↓
Execute → results.json
  ↓
Analyze → update metrics
  ↓
Reflect → findings and gaps
  ↓
Decide → continue / pivot / pause / complete
  ↓
Mission state + AgentState checkpoint
  ↓
Experiment evidence → Wiki compile → Wiki reflection
```

The offline designer runs a reproducible local probe and returns inconclusive
for domain-specific claims. Anthropic mode is responsible for reviewed,
Mission-specific experiment code.

## Knowledge lifecycle

```text
raw file / URL / search result / experiment
  ↓ ingest
sources/<sha256>.json
  ↓ manifest
raw/manifest.json (original hash + restoration URI)
  ↓ compile
wiki/sources + wiki/concepts + index + log
  ↓
meta/knowledge_graph.json + gaps + capabilities
  ↓ reflect
meta/reflection/<timestamp>.md
  ↓ optional learn
Crossref search → evidence import → recompile
```

Generated pages preserve source provenance and retain user content placed after
the generated marker.

Raw binaries are optional. The manifest separates portable reconstruction
metadata from Git-hosted Markdown/JSON. A restore operation downloads or copies
the original bytes, validates their hash, and writes only inside `raw/`.

## Persistence

- Mission state: `missions/active/<mission-id>.state.json`
- Experiment state: `experiments/<experiment-id>/`
- Cross-session state: `.agent-state.json`
- Knowledge artifacts: companion wiki repository

Writes use temporary files and atomic rename. `.agent-state.json` also uses a
local lock to prevent same-machine write races.

Continuous daemon runs additionally use a per-Mission lock under `runs/locks/`.
Structured run records and JSONL events under `runs/` support recovery,
history inspection, and operational health checks.

## Safety model

- Docker sandbox: no network by default, dropped capabilities, process/memory/
  CPU limits, read-only root filesystem, bounded timeout.
- Local sandbox: explicit command allowlist and output/timeout limits.
- Static generated-code policy rejects child processes, network APIs, dynamic
  evaluation, process termination, and parent-directory traversal.
- Hard safety violations cannot be approved.
- Budget and iteration thresholds stop continuation.
- Pull, commit, push, paid LLM use, and active network learning are explicit.

## What “self-learning” means

The system updates structured knowledge, Mission metrics, findings, gaps,
reflection records, and reusable evidence. It does not update foundation-model
weights.
