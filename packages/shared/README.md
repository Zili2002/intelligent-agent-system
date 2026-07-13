# Shared State and Synchronization

This package provides the `.agent-state.json` schema and synchronization
primitives used by the autonomous agent.

## Safety defaults

- Checkpoints are atomic and protected by a local lock.
- Mission action queues are replaced; durable findings, warnings, decisions,
  improvements, gaps, and conflicts are merged without duplicates.
- Onboarding reads local state by default.
- Git pulls require `pullCode` or `pullWiki` and use `--ff-only`.
- Handoff checkpoints locally by default.
- Git commit and push operations require explicit options.
- Remote and branch values are configurable and default to the repository's
  current branch rather than hard-coded `main` or `wiki` branches.

## API

```ts
import {
  onboardAgent,
  saveCheckpoint,
  handoffAgent,
} from "@intelligent-agent/shared";

await saveCheckpoint({ context: { keyFindings: ["verified result"] } }, root);

const context = await onboardAgent({ projectRoot: root });

await handoffAgent("paused", {}, root); // local checkpoint only
```

Tests use temporary directories and do not access a network or mutate Git
history.
