# Deployment Guide

## Prerequisites

- Node.js 20+
- Docker (for sandboxed execution)
- Git
- GitHub account
- Anthropic API key

## Initial Setup

### 1. Clone Repositories

```bash
# Clone main system
git clone https://github.com/Zili2002/intelligent-agent-system.git
cd intelligent-agent-system

# Clone wiki (or create your own)
cd ..
git clone https://github.com/Zili2002/my-research-wiki.git
```

### 2. Install Dependencies

```bash
cd intelligent-agent-system
npm install
npm run build
```

### 3. Configure Environment

Create `.env` file in project root:

```bash
ANTHROPIC_API_KEY=your_api_key_here
WIKI_PATH=../my-research-wiki
```

### 4. Verify Setup

```bash
# Check agent state
cat .agent-state.json

# Test autonomous agent
cd packages/autonomous-agent
npm run dev -- --help

# Test wiki compiler
cd ../llm-wiki-compiler
npm run dev -- --help
```

## Multi-Device Workflow

### Device A (Initial Setup)

```bash
# Start a mission
cd intelligent-agent-system/packages/autonomous-agent
npm run dev -- explore ../../examples/missions/example-mission.md

# Agent runs, automatically checkpointing state
# On exit, agent commits .agent-state.json and pushes
```

### Device B (Resume Work)

```bash
# Pull latest state
cd intelligent-agent-system
git pull origin master

# Agent automatically loads state and shows summary
npm run dev -- explore

# Prompt to resume previous mission
# > Resume mission "Understanding Self-Evolving Agent Systems" from Phase 2? (y/n)
```

### Conflict Resolution

If two devices work simultaneously:

```bash
# Pull with rebase
git pull --rebase origin master

# If .agent-state.json conflicts, the system auto-merges:
# - Takes latest timestamp as base
# - Merges context arrays (findings, questions, warnings)
# - Preserves all unique data

# Push resolved state
git push origin master
```

## Cloud Deployment

### Option 1: GitHub Actions (Scheduled Runs)

Add to `.github/workflows/autonomous-run.yml`:

```yaml
name: Autonomous Agent Run

on:
  schedule:
    - cron: '0 */6 * * *'  # Every 6 hours
  workflow_dispatch:

jobs:
  explore:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Build
        run: npm run build
      
      - name: Run agent
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          cd packages/autonomous-agent
          npm run start -- explore --auto-resume --max-duration 3600
      
      - name: Commit state
        run: |
          git config user.name "Agent Bot"
          git config user.email "bot@example.com"
          git add .agent-state.json
          git commit -m "chore: agent checkpoint from GitHub Actions" || true
          git push
```

### Option 2: AWS Lambda (Event-Driven)

```bash
# Package for Lambda
cd intelligent-agent-system
npm run build
zip -r agent.zip packages/autonomous-agent/dist node_modules

# Deploy with AWS CLI
aws lambda create-function \
  --function-name autonomous-agent \
  --runtime nodejs24.x \
  --handler dist/lambda.handler \
  --zip-file fileb://agent.zip \
  --environment Variables="{ANTHROPIC_API_KEY=$API_KEY}"
```

### Option 3: Docker Container

```bash
# Build image
docker build -t intelligent-agent:latest .

# Run with mounted volumes
docker run -it \
  -e ANTHROPIC_API_KEY=$API_KEY \
  -v $(pwd)/.agent-state.json:/app/.agent-state.json \
  -v $(pwd)/../my-research-wiki:/app/wiki \
  intelligent-agent:latest explore
```

## Best Practices

### Budget Management

- Set conservative budget limits in mission documents
- Monitor spending via `.agent-state.json`
- Agent automatically stops when budget exceeded

### State Management

- Commit `.agent-state.json` after every significant operation
- Pull before starting work on a new device
- Review state diff before pushing

### Wiki Maintenance

- Wiki has its own Git repo for clean separation
- Run `llmwiki lint` periodically to check health
- Review LLM-generated pages before major milestones

### Security

- Never commit `.env` files
- Use GitHub secrets for CI/CD
- Sandbox all experiment execution
- Review experiment code before running

## Troubleshooting

### State Conflicts

```bash
# If auto-merge fails
git checkout --theirs .agent-state.json
git add .agent-state.json
git commit -m "chore: resolve state conflict"
```

### Corrupted State

```bash
# Reset to last known good state
git log --oneline .agent-state.json
git checkout <commit> .agent-state.json
git commit -m "fix: restore state from <commit>"
```

### Wiki Sync Issues

```bash
cd ../my-research-wiki
git pull --rebase origin master
# Resolve any conflicts in wiki pages
git push origin master
```

## Monitoring

### Check Agent Status

```bash
# View current state
cat .agent-state.json | jq '.mission.status'

# View budget usage
cat .agent-state.json | jq '.mission.budget'

# View exploration progress
cat .agent-state.json | jq '.exploration'
```

### View Recent Activity

```bash
# Git log for state changes
git log --oneline .agent-state.json

# Wiki activity log
cat ../my-research-wiki/wiki/log.md | tail -20
```

## Next Steps

1. Define your first mission in `examples/missions/`
2. Ingest some initial sources into the wiki
3. Run the agent and observe its exploration
4. Review generated wiki pages and experiment results
5. Let the agent propose improvements
6. Iterate!
