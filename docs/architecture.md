# Architecture Overview

## System Components

The intelligent agent system consists of three main packages and two repositories:

### Repositories

1. **intelligent-agent-system** (main repo)
   - Contains all agent code
   - Tracks `.agent-state.json` for multi-device sync
   - Houses mission documents and experiment results

2. **my-research-wiki** (wiki repo)
   - Stores compiled knowledge base
   - LLM-maintained markdown files
   - Version-controlled for full history

### Packages

1. **autonomous-agent**
   - Mission-driven exploration engine
   - Experiment design and execution
   - Hypothesis generation and testing
   - Docker sandbox integration

2. **llm-wiki-compiler**
   - Source ingestion and summarization
   - Wiki compilation and cross-referencing
   - Health checking and linting
   - Query interface

3. **shared**
   - Multi-device synchronization primitives
   - Agent state management
   - Type definitions
   - Common utilities

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                         User / Researcher                    │
└────────────┬──────────────────────────────────┬─────────────┘
             │                                  │
             │ Define mission                   │ Add sources
             ▼                                  ▼
┌─────────────────────────┐        ┌──────────────────────────┐
│   Autonomous Agent      │        │   Wiki Compiler          │
│   ─────────────────     │        │   ──────────────         │
│   • Load mission.md     │◄───────┤   • Ingest sources       │
│   • Generate hypotheses │        │   • Summarize & link     │
│   • Design experiments  │        │   • Update index         │
│   • Run in sandbox      │        │   • Compile wiki         │
│   • Analyze results     │────────►   • Generate ideas       │
│   • Update wiki         │        └──────────────────────────┘
│   • Reflect & evolve    │                    │
└─────────────────────────┘                    │
             │                                  │
             │ Checkpoint                       │ Git commit
             ▼                                  ▼
┌─────────────────────────────────────────────────────────────┐
│                    .agent-state.json                         │
│                    ────────────────                          │
│   • Mission progress                                         │
│   • Budget tracking                                          │
│   • Key findings                                             │
│   • Open questions                                           │
│   • Next actions                                             │
└─────────────────────────────────────────────────────────────┘
             │
             │ Git push
             ▼
┌─────────────────────────────────────────────────────────────┐
│                      GitHub (Remote)                         │
│   ────────────────────────────────────                       │
│   • Code repository                                          │
│   • Wiki repository                                          │
│   • State snapshots (versioned)                              │
└─────────────────────────────────────────────────────────────┘
             │
             │ Git pull
             ▼
┌─────────────────────────────────────────────────────────────┐
│                   Other Devices / Agents                     │
│   ───────────────────────────────────────                    │
│   • Resume from state                                        │
│   • Continue exploration                                     │
│   • Seamless handoff                                         │
└─────────────────────────────────────────────────────────────┘
```

## Core Loops

### 1. Exploration Loop (autonomous-agent)

```
┌──────────────────────────────────────────────────┐
│                                                  │
│  Orient ──► Hypothesize ──► Design ──► Execute  │
│    ▲                                      │      │
│    │                                      │      │
│    └──────────── Analyze ◄───────────────┘      │
│                    │                             │
│                    ▼                             │
│                 Reflect                          │
│                    │                             │
│                    ▼                             │
│             Update State & Wiki                  │
│                                                  │
└──────────────────────────────────────────────────┘
```

**Orient**: Survey the landscape
- Read existing wiki pages
- Review prior experiments
- Identify knowledge gaps

**Hypothesize**: Generate testable ideas
- Based on current understanding
- Guided by mission objectives
- Scoped to budget constraints

**Design**: Create experiments
- Define variables and controls
- Write experiment code
- Specify success metrics

**Execute**: Run in sandbox
- Docker container isolation
- Resource limits enforced
- Capture all outputs

**Analyze**: Interpret results
- Compare to hypothesis
- Extract key findings
- Update confidence levels

**Reflect**: Meta-level reasoning
- What worked? What didn't?
- What new questions emerged?
- How can we improve?

### 2. Knowledge Compilation Loop (llm-wiki-compiler)

```
┌──────────────────────────────────────────────────┐
│                                                  │
│  Ingest ──► Summarize ──► Link ──► Index        │
│                            │                     │
│                            ▼                     │
│                      Update Pages                │
│                            │                     │
│                            ▼                     │
│                      Git Commit                  │
│                                                  │
└──────────────────────────────────────────────────┘
```

**Ingest**: Process new sources
- Parse PDFs, markdown, web pages
- Extract main content
- Tag with metadata

**Summarize**: Distill key information
- Generate concise summaries
- Identify entities and concepts
- Note important claims

**Link**: Connect to existing knowledge
- Find related wiki pages
- Add cross-references
- Update relationship graph

**Index**: Maintain navigation
- Update index.md with new pages
- Append to log.md
- Regenerate search indices

**Update Pages**: Keep wiki current
- Revise entity pages with new info
- Strengthen or challenge existing claims
- Flag contradictions

### 3. Evolution Loop (self-improvement)

```
┌──────────────────────────────────────────────────┐
│                                                  │
│  Run ──► Observe ──► Reflect ──► Propose        │
│   ▲                                 │            │
│   │                                 │            │
│   └────────────── Apply ◄───────────┘            │
│                     │                            │
│                     ▼                            │
│                Checkpoint                        │
│                                                  │
└──────────────────────────────────────────────────┘
```

**Run**: Execute missions
- Follow exploration loop
- Track metrics and outcomes
- Identify patterns

**Observe**: Monitor performance
- What's working well?
- Where are bottlenecks?
- What patterns repeat?

**Reflect**: Deep analysis
- Why did X succeed/fail?
- What assumptions were wrong?
- What didn't we consider?

**Propose**: Generate improvements
- Code refactorings
- New skills/tools
- Prompt refinements
- Configuration tweaks

**Apply**: Implement changes
- Test proposed improvements
- Commit if beneficial
- Rollback if not

**Checkpoint**: Record evolution
- Log improvement in state
- Track success rate
- Build institutional memory

## Multi-Device Synchronization

### State Snapshot Format

`.agent-state.json` captures:

- **Session**: Current run metadata
- **Mission**: Active objective and progress
- **Knowledge**: Wiki statistics
- **Exploration**: Hypothesis and experiment counts
- **Evolution**: Improvements applied
- **Context**: Findings, questions, decisions, warnings
- **Sync**: Git metadata

### Sync Protocol

1. **Agent Start**:
   - `git pull` latest code and state
   - Load `.agent-state.json`
   - Generate human-readable summary
   - Prompt to resume or start fresh

2. **During Run**:
   - Checkpoint every 5 minutes
   - Write state to disk (not pushed yet)
   - Continue work

3. **Agent Exit**:
   - Final checkpoint
   - `git commit` state file
   - `git push` to remote
   - Wiki also pushed if changed

4. **Conflict Resolution**:
   - Automatic merge if possible
   - Take latest timestamp as base
   - Union of context arrays
   - Manual intervention if needed

## Deployment Modes

### Local Development

```bash
# Single device, interactive
npm run dev -- explore mission.md
```

Agent runs locally with full control. Checkpoints saved but not auto-pushed.

### Multi-Device Handoff

```bash
# Device A
npm run start -- explore mission.md  # Runs and auto-pushes on exit

# Device B (later)
npm run start -- explore             # Auto-resumes from state
```

Seamless continuation across devices via Git sync.

### Scheduled Cloud Runs

```yaml
# GitHub Actions
on:
  schedule:
    - cron: '0 */6 * * *'
```

Agent runs periodically in cloud, commits progress, stops when budget reached.

### Continuous Exploration

```bash
# Long-running server
docker run -d intelligent-agent:latest explore --continuous
```

Agent runs indefinitely, checkpointing and syncing state continuously.

## Security Model

### Sandboxing

- All experiment code runs in Docker containers
- Limited CPU, memory, network access
- No access to host filesystem
- Disposable after execution

### Secrets Management

- API keys in `.env` (gitignored)
- GitHub secrets for CI/CD
- No secrets in state file

### Code Review

- Experiments logged before execution
- Human review optional via hooks
- All results versioned in Git

## Scalability Considerations

### Current Scale (MVP)

- ~100 sources in wiki
- ~500 wiki pages
- ~10 concurrent missions
- Index-based search (no embeddings)

### Future Scale

- 1000+ sources
- 5000+ wiki pages
- Vector search integration (qmd)
- Distributed execution
- Multi-agent collaboration

## Technology Stack

- **Language**: TypeScript
- **Runtime**: Node.js 24+
- **LLM**: Claude API (Anthropic)
- **Sandbox**: Docker
- **VCS**: Git + GitHub
- **CI/CD**: GitHub Actions
- **Docs**: Markdown + Obsidian

## Design Principles

1. **Simplicity First**: Start with simple solutions, add complexity only when needed
2. **Git as SSOT**: Single source of truth for code, state, and knowledge
3. **Incremental Evolution**: Small improvements compound over time
4. **Human in the Loop**: Agent proposes, human approves
5. **Fail-Safe Defaults**: Conservative budgets, sandboxed execution
6. **Reproducibility**: All experiments versioned and documented
7. **Observability**: State fully inspectable at any time

## Future Directions

### Phase 1 (Current)

- ✅ Basic agent + wiki compiler
- ✅ Multi-device sync
- ✅ Mission-driven exploration
- ✅ Self-evolution proposals

### Phase 2 (Next)

- ⬜ Vector search for large wikis
- ⬜ Multi-agent collaboration
- ⬜ Tool/skill marketplace
- ⬜ Auto-apply safe improvements

### Phase 3 (Future)

- ⬜ Distributed execution
- ⬜ Web interface
- ⬜ Real-time collaboration
- ⬜ Domain-specific agents
