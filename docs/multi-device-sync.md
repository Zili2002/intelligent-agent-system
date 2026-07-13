# Multi-device state and handoff

## State file

`.agent-state.json` records:

- session timestamps and device
- active Mission, phase, completed experiments, and next actions
- budget usage
- Wiki path, counts, and last compile metadata
- exploration totals and last experiment
- findings, gaps, decisions, and warnings
- Git remote/branch metadata

Mission and experiment JSON remain the detailed source of truth; AgentState is
the compact handoff snapshot.

## Checkpoint semantics

- A lock file prevents same-machine concurrent writers.
- Content is written to a temporary file and atomically renamed.
- Mission queues such as `nextActions` are replaced.
- Durable arrays such as findings, warnings, gaps, decisions, improvements,
  and conflicts are merged and deduplicated.
- Malformed state is surfaced as an error rather than silently replaced.

## Onboarding

```bash
# Local read only
autonomous-agent --root <workspace> onboard

# Explicit network pulls
autonomous-agent --root <workspace> onboard --pull --pull-wiki
```

Pull behavior:

- detects/configures branch instead of hard-coding `main` or `wiki`
- uses `git pull --ff-only`
- refuses repositories with uncommitted changes
- records successful synchronization metadata
- returns warnings when an explicitly requested pull cannot run

## Handoff

```bash
# Local checkpoint only
autonomous-agent --root <workspace> handoff --reason paused

# Explicit Git effects
autonomous-agent --root <workspace> handoff --commit
autonomous-agent --root <workspace> handoff --push
autonomous-agent --root <workspace> handoff --commit-wiki
autonomous-agent --root <workspace> handoff --push-wiki
```

Push requires commit. Wiki and Agent repository effects are independently
controlled.

## Conflict model

The implementation does not claim to auto-resolve arbitrary Git conflicts.
Fast-forward-only pull prevents hidden rebases or merges. Resolve divergent Git
history explicitly, then rerun onboarding.

Within one state file, checkpoint merge rules preserve durable context while
replacing current queues. This is not a distributed lock; simultaneous writers
on different machines still require normal Git coordination.

## Recommended workflow

1. Finish or pause the current cycle.
2. Run local handoff and inspect `.agent-state.json`.
3. Explicitly commit/push when ready.
4. On the next device, start with a clean worktree.
5. Explicitly pull and run `onboard`.
6. Resume the persisted Mission or experiment ID.
