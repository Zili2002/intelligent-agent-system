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
- `budget`: auto-approval and stop thresholds
- `wikiPath`: companion repository path
- `autoCompileWiki`: compile verified experiment evidence
- `autoLearnWiki`: allow network search from generated gaps
- `maxIterations`: hard Mission iteration limit

Environment overrides:

```bash
ANTHROPIC_API_KEY=...
ANTHROPIC_AUTH_TOKEN=...
ANTHROPIC_BASE_URL=http://localhost:...
ANTHROPIC_MODEL=...
WIKI_PATH=../my-research-wiki
AGENT_SANDBOX=local
```

Do not commit `.env` files.

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
llmwiki --root <wiki-repository> status
llmwiki --root <wiki-repository> lint
```

Review diffs before any commit or push.
