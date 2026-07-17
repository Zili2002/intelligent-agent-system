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
  ├─ Crossref / arXiv / OpenAlex provider registry
  ├─ normalized identifier merge and OA full-text acquisition
  ├─ section-aware chunking and independent chunk cache
  ├─ complete Claim Registry and rejected-claim audit
  ├─ topic-sharded synthesis and full-registry relationship graph
  ├─ deterministic source scoring and Claim evidence confidence
  ├─ cached LLM source analysis and synthesis
  ├─ validated Claim–Evidence graph and cited LLM query
  ├─ deterministic provenance/link/schema validation
  ├─ LLM reflection with referenced claims and sources
  └─ multi-provider LLM-screened bounded learning

research-reader
  ├─ versioned Paper Passport / Review / Reading Session state
  ├─ subscriptions, provider tracking, triage, queues, reports, and recovery
  ├─ OA acquisition and evidence-grounded Fast / Standard / Deep review
  ├─ exact-quote Q&A, comparison, notes, annotations, and Wiki extraction
  ├─ feedback, bounded profile learning, calibration, retention, and analytics
  ├─ Paper–Claim–Topic navigation and evidence-grounded survey planning
  └─ folder / Obsidian / Zotero / LaTeX / PubMed / conference adapters

research-reader-web
  ├─ localhost-only Node API and static React client
  ├─ PDF.js with lazy-loaded PDF runtime
  ├─ Review, text/PDF, question, and annotation panels
  ├─ handwriting, optional browser voice transcription, and local notification
  └─ CSRF, content-security policy, and path confinement

shared
  ├─ AgentState types
  ├─ atomic locked checkpoints
  ├─ explicit ff-only onboarding
  ├─ explicit commit/push handoff
  └─ generic atomic JSON, locks, retries, redacted JSONL, and sanitization
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

## Research reading cycle

```text
Subscription / adapter
  ↓
Provider search → canonical identity → deterministic triage
  ↓ optional approved LLM triage
Paper Passport → reading queue → approved OA acquisition
  ↓
Fast / Standard / Deep Review with exact evidence anchors
  ↓
Quick Scan / Guided Read / Deep Dive / Compare / Extract
  ↓
Feedback → bounded Profile update → calibration and reports
  ↓
Paper–Claim–Topic navigation, retention, and survey planning
```

Scientific quality, evidence confidence, personal relevance, reading priority,
and user value remain separate persisted values. Missing source coverage is
represented as `unknown`, never inferred into a quality score.

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
Crossref / arXiv / OpenAlex → merge → OA full text → chunk → recompile
```

arXiv requests are globally serialized at a minimum three-second interval.
OpenAlex credentials remain environment-only. Learning shares one download and
Token budget across all selected gaps and never treats a landing page as
downloadable full text.

`meta/claims.json` is the durable evidence registry. The 16-Claim summary graph
is only a compatibility and index view. `meta/claim_graph.json` and generated
topic pages may reference any accepted Registry Claim, so contradiction
knowledge is not lost when a Claim is absent from the summary.

`meta/source_scores.json` and `meta/claim_confidence.json` are deterministic,
auditable quality artifacts. Scores use stored evidence facts (not an LLM) and
confidence describes evidence strength rather than truth probability. Synthetic
simulation evidence is explicitly detected and capped. `corroborate` turns
weak Claims into separate confirming and challenging searches, then recompiles
only uncached evidence work. `contradiction_adjudications.json` stores
LLM-assisted but schema-constrained resolutions whose rationales may cite only
the immutable Claims supplied to the adjudicator; unresolved or insufficient
evidence remains explicit rather than being converted into a verdict.

`meta/semantic_index.json` is a content-addressed local Claim vector index.
MiniLM embeddings are normalized and quantized to signed bytes; unchanged
Claim hashes reuse existing vectors, removed Claims disappear, and stale
vectors are ignored by query. Hybrid retrieval combines semantic, lexical,
graph, confidence, and contradiction-pair signals before the bounded LLM
answer/rerank step. `retrieval_benchmark.json` is fixed after creation and
`retrieval_evaluation.json` records Recall@10, citation validity and recall,
no-evidence refusal, contradiction coverage, latency, and Token usage.

The embedding profile includes model, ONNX dtype, query prefix, and passage
prefix. This prevents vectors produced with E5-style `query: `/`passage: `
inputs from being mixed with MiniLM vectors. Candidate indexes and evaluation
artifacts live beside the production index and never replace it without an
explicit measured decision.

`meta/evidence_frontier.json` is the backpressure boundary for autonomous
search. Exact intent-aware fingerprints and local MiniLM vectors merge lexical
and semantic duplicates across gaps and Claims without merging support and
challenge intent. Stable problem/topic IDs enforce hierarchical quotas.
Selection ranks expected information gain while preserving problem/topic
diversity. At 70% capacity low-priority admission is throttled; at 90% only
critical or refresh work is admitted. Repeated no-novelty searches open a
long-cooldown circuit breaker. Terminal entries compact into bounded
fingerprint-only history, and a cross-process lock prevents concurrent writers
from bypassing capacity.

`refresh` checks OpenAlex metadata and exact arXiv versions on a configured
interval. A newer version creates one high-priority Frontier clue instead of
immediate unbounded fan-out. `knowledge_lifecycle.json` records metadata,
version, retraction, and source-supersession events. Retracted and superseded
Claims are excluded from normal affirmative retrieval; version-review Claims
remain provisional until the new full text is acquired.

Generated pages preserve source provenance and retain user content placed after
the generated marker.

Semantic Wiki operations have no rule-based content fallback. They require a
non-empty research focus, Anthropic credentials, and explicit Wiki-specific
approval. Exact source quotes, source IDs, claim IDs, cache keys, and token
limits are validated deterministically. Agent Wiki calls use a separate
approval boundary and count actual usage against the Mission token budget.
The default reasoning configuration uses Claude Opus 4.8 adaptive thinking at
high effort; sampling temperature is omitted because Opus 4.8 does not expose
adjustable sampling controls.

Compilation uses bounded parallel stages. Independent source chunks, topics,
relationship batches, and contradiction batches run concurrently, but each LLM
request first obtains an atomic conservative Token reservation. The Claim graph
is incremental: prior valid edges are retained, and a compile analyzes only
pairs touching newly added Claims or explicit corroboration targets. State,
Frontier, lifecycle, and Git writes remain serialized.

Exact arXiv identifiers use a strict one-work retrieval path and never fan out
into loosely related provider candidates. Global synthesis milestones are based
on full-text evidence count rather than raw artifact count, preventing
metadata-only branches from amplifying global compilation.

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
