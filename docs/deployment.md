# Deployment

## Local

Requirements:

- Node.js 20+
- Git
- Docker only for the Docker experiment sandbox

```bash
npm install
npm run build
npm test
npm run lint
```

Initialize the companion Wiki and Agent workspace as shown in
`QUICKSTART.md`.

## Configuration

Agent settings live in `.agent-config.json`.

Important settings:

- `sandbox.type`: `docker`, `local`, or `hybrid`
- `analysis.mode`: `rule-based`, `llm`, or `hybrid`
- `analysis.llm`: model, token limit, and configurable token pricing
- `analysis.llm.thinking`: adaptive/disabled mode and effort level
- `budget`: auto-approval and stop thresholds
- `wikiPath`: companion repository path
- `autoCompileWiki`: compile verified experiment evidence
- `autoLearnWiki`: allow network search from generated gaps
- `wikiLlm.approved`: persistent, explicit approval for billable Wiki LLM calls
- `wikiLlm.maxTokensPerSync`: per-sync cap, additionally bounded by the Mission
  token budget
- `maxIterations`: hard Mission iteration limit

Environment overrides:

```bash
ANTHROPIC_API_KEY=...
ANTHROPIC_AUTH_TOKEN=...
ANTHROPIC_BASE_URL=http://localhost:...
ANTHROPIC_MODEL=...
OPENALEX_API_KEY=...
OPENALEX_MAILTO=...
LLMWIKI_MODEL_CACHE=C:\model-cache
WIKI_PATH=../my-research-wiki
AGENT_SANDBOX=local
```

Do not commit `.env` files.

The Wiki repository must also define a non-empty `researchFocus` and `llm`
limits in `.llmwiki-config.json`. Direct semantic CLI commands require the
global `--approve-llm` flag and default to a 10,000-token operation guard,
configurable with `--max-llm-tokens`. Raw search, ingestion, status, lint,
manifest, and restoration do not call the model.

`llmwiki index` downloads the configured public ONNX embedding model on first
use and performs inference locally. Set `LLMWIKI_MODEL_CACHE` to persistent
storage outside the Wiki Git repository; only the quantized
`meta/semantic_index.json` artifact is portable.

Run `llmwiki refresh` on a schedule no more frequently than
`lifecycle.refreshIntervalHours`. Process accumulated work with
`llmwiki --approve-llm frontier-run`; each cycle is hard-capped by
`maxQueriesPerCycle`, provider result limits, download limits, and the operation
Token budget. Multiple rapid scheduler ticks therefore do not multiply search
fan-out.

Frontier admission becomes `throttled` at the configured high watermark and
`critical` at the critical watermark. Monitor `frontierOccupancyPercent`,
`frontierAdmissionMode`, semantic-deduplication, circuit-breaker, and compaction
counters through `llmwiki status` or `llmwiki frontier`. The Frontier file is
cross-process locked, so multiple schedulers cannot exceed quotas by racing.

Recommended initial semantic concurrency is 3 source analyses, 3 topic
summaries, 4 relationship batches, 3 adjudication batches, 3 screening calls,
and 2 Frontier clues. Increase only after observing proxy rate limits and
memory. arXiv remains globally serialized regardless of Frontier concurrency.

arXiv metadata search requires no credential and is throttled to one request
start every three seconds. OpenAlex requires `OPENALEX_API_KEY`. Full-text
acquisition accepts only explicit PDF/HTML/text/XML locations, defaults to
open-access-only, and never follows a landing page as downloadable content.

The default Anthropic configuration is `claude-opus-4-8` with adaptive
thinking and high effort. Proxy-specific aliases are supported through
`ANTHROPIC_MODEL`; terminal-format suffixes are removed only in memory before
the request.

## Docker image

```bash
docker build -t intelligent-agent-system:local .
docker run --rm intelligent-agent-system:local --help
```

Mount an Agent workspace and Wiki repository for real use. A container cannot
run nested Docker experiments unless an explicitly reviewed Docker daemon
integration is supplied; use the local Node sandbox inside the container or
configure that integration deliberately.

## CI

`.github/workflows/ci.yml` runs on `master`, `develop`, pull requests, and
manual dispatch:

1. internal-registry `npm ci`
2. ordered workspace build
3. all tests
4. type/format lint
5. real Docker sandbox experiment
6. Docker image build

The workflow does not publish an image.

## Git synchronization

Network and history-changing operations are disabled by default.

```bash
# Local state only
autonomous-agent --root <workspace> onboard
autonomous-agent --root <workspace> handoff

# Explicit pulls
autonomous-agent --root <workspace> onboard --pull --pull-wiki

# Explicit local commit or push
autonomous-agent --root <workspace> handoff --commit
autonomous-agent --root <workspace> handoff --push
```

Pull uses `--ff-only` and refuses a dirty repository. Branches and remotes come
from state/options or the current Git branch.

## Operational checks

```bash
autonomous-agent --root <workspace> mission-status <mission-id>
autonomous-agent --root <workspace> health --docker
autonomous-agent --root <workspace> runs
autonomous-agent --root <workspace> history
autonomous-agent --root <workspace> approvals
llmwiki --root <wiki-repository> status
llmwiki --root <wiki-repository> lint
```

Review diffs before any commit or push.

## Continuous scheduler

```bash
autonomous-agent --root <workspace> daemon <mission-id> \
  --interval 300 \
  --max-duration 86400 \
  --max-cycles 100 \
  --retry-attempts 3 \
  --retry-delay 5
```

Only one process may run a Mission at a time. Stale locks are recovered when
their owning process is gone. Transient network/runtime failures use bounded
exponential retry; policy, budget, safety, and configuration failures are not
retried.
