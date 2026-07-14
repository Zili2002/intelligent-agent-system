# Autonomous Agent

Mission-driven exploration with durable state, sandboxed experiments, result
analysis, reflection, and bounded autonomous continuation.

## Implemented loop

```text
Orient -> Hypothesize -> Design -> Safety/Approval -> Execute
       -> Analyze -> Reflect -> Decide -> Checkpoint
```

Each experiment is stored under `experiments/<experiment-id>/` with:

- `experiment.json` — hypothesis, design, status, execution, and analysis
- `experiment.mjs` (or another configured entrypoint) — executable code
- `results.json` — structured evidence produced by the experiment
- `reflection.json` — lessons and knowledge extracted from verified results

Mission state is stored atomically under
`missions/active/<mission-id>.state.json`. Cross-session context is also
checkpointed to the workspace `.agent-state.json`.

## Setup

From the monorepo root:

```bash
npm install
npm run build
```

Initialize a workspace:

```bash
node packages/autonomous-agent/dist/cli.js --root <workspace> init
```

The generated `.agent-config.json` controls the reasoning mode, sandbox,
budget thresholds, wiki path, and maximum iterations.

## Commands

```bash
# Start and persist a Markdown mission
autonomous-agent --root <workspace> mission-start <mission.md>

# Only this command discards progress, after writing a backup
autonomous-agent --root <workspace> mission-start <mission.md> --reset

# Inspect current progress
autonomous-agent --root <workspace> mission-status <mission-id>
autonomous-agent --root <workspace> orient <mission-id>

# Run one complete cycle
autonomous-agent --root <workspace> explore <mission-id>

# Run bounded cycles until complete or paused
autonomous-agent --root <workspace> run <mission-id> --max-cycles 3

# Run a lock-protected continuous scheduler
autonomous-agent --root <workspace> daemon <mission-id> \
  --interval 300 --max-duration 86400 --max-cycles 100

# Inspect operations and approvals
autonomous-agent --root <workspace> runs
autonomous-agent --root <workspace> history
autonomous-agent --root <workspace> health --docker
autonomous-agent --root <workspace> approvals
autonomous-agent --root <workspace> approval-approve \
  <mission-id> <approval-or-experiment-id>
autonomous-agent --root <workspace> approval-reject \
  <mission-id> <approval-or-experiment-id> --reason "reason"

# Explicitly allow Wiki gap search/import for this invocation
autonomous-agent --root <workspace> explore <mission-id> --learn

# Resume a checkpointed or approval-gated experiment
autonomous-agent --root <workspace> experiment-resume \
  <mission-id> <experiment-id> --approve

# Read local handoff context; Git pulls are explicit
autonomous-agent --root <workspace> onboard
autonomous-agent --root <workspace> onboard --pull --pull-wiki

# Local checkpoint by default; Git effects require explicit flags
autonomous-agent --root <workspace> handoff --reason paused
autonomous-agent --root <workspace> handoff --commit
```

## Reasoning modes

- `rule-based`: deterministic offline design. It runs a reproducible local
  probe and explicitly reports when domain-specific evidence is still missing.
- `llm`: accepts `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, with optional
  `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` overrides.
- `hybrid`: uses Anthropic when configured and otherwise reports that it is
  using the offline designer.

The offline designer never represents a generic probe as proof of a
mission-specific hypothesis.

## Sandboxes

- `docker`: default isolation with resource, capability, process, filesystem,
  and network restrictions. Docker must be installed.
- `local`: explicit process execution using an allowlist. The default allows
  only the current Node executable, filters inherited environment variables,
  and always requires explicit approval.
- `hybrid`: local for short configured experiments and Docker otherwise.

Generated code is statically checked before execution. Child processes,
network access, dynamic evaluation, process termination, and parent-directory
traversal are rejected. Static checks complement rather than replace Docker
isolation.

For a local offline run:

```bash
autonomous-agent --root <workspace> explore <mission-id> \
  --sandbox local --offline --approve
```

## Approval and budgets

Mission budget fields and `.agent-config.json` determine whether an experiment
can be auto-approved. Hard safety violations cannot be approved. Explicit
approval is available through `--approve`, and continuous runs stop when
success metrics, budget thresholds, or iteration limits require it.

Model-specific input/output pricing is configurable; the agent does not assume
pricing for an arbitrary model. Active Wiki search is disabled by default
because it performs external network requests.

## Continuous operation

`daemon` acquires an exclusive cross-process Mission lock, recovers approved or
interrupted experiments, retries transient failures with bounded exponential
backoff, and records each run under `runs/`.

Paid LLM requests and local experiments can enter the approval queue. Approval
and rejection decisions are persisted as structured history events. A daemon
exits with `waiting_approval` instead of bypassing policy.

## Tests

```bash
npm test --workspace autonomous-agent
```

Tests use temporary workspaces, the installed Node runtime, and deterministic
offline reasoning. They do not perform paid API calls or network searches.
