# Mission Document Format

Mission documents define what the agent should explore and how. They are markdown files that guide the autonomous exploration process.

## Template

```markdown
# Mission: [Clear, Specific Title]

**Status**: Draft | Active | Paused | Completed  
**Budget**: $X USD  
**Duration**: X days/weeks  
**Priority**: Low | Medium | High | Critical
**Iterations**: Maximum autonomous cycles

## Objective

[1-2 paragraphs describing what you want to achieve. Be specific about the end goal, not just the process.]

## Success Criteria

[Measurable outcomes that define success. Use concrete metrics.]

1. **Criterion 1**: [Specific metric]
2. **Criterion 2**: [Specific metric]
3. **Criterion 3**: [Specific metric]

## Constraints

[Hard limits and boundaries for the exploration]

- **Budget**: [Maximum spend]
- **Time**: [Deadline or duration]
- **Scope**: [What's in/out of scope]
- **Safety**: [Safety requirements]

## Approach

[High-level strategy. Can be organized by phases, methods, or priorities.]

### Phase 1: [Name]

[What to do in this phase]

### Phase 2: [Name]

[What to do in this phase]

## Exploration Strategy

[How to balance breadth vs depth, when to stop, what to prioritize]

## Deliverables

[Concrete outputs expected at the end]

1. **Deliverable 1**: [Description]
2. **Deliverable 2**: [Description]

## Notes

[Optional: Additional context, inspirations, references]
```

## Example 1: Research Mission

```markdown
# Mission: Understanding Neural Scaling Laws

**Status**: Draft  
**Budget**: $30 USD  
**Duration**: 5 days  
**Priority**: High

## Objective

Develop a comprehensive understanding of how neural network performance scales with model size, dataset size, and compute. Identify the key empirical findings, theoretical frameworks, and open questions in this domain.

## Success Criteria

1. **Literature Coverage**: At least 8 seminal papers ingested and summarized
2. **Synthesis**: Clear articulation of 3-5 scaling laws with mathematical formulations
3. **Experiments**: 2 validation experiments demonstrating scaling behavior
4. **Knowledge Base**: Wiki pages for key researchers, concepts, and datasets
5. **Report**: 10-page synthesis with visualizations and citations

## Constraints

- **Budget**: Maximum $30 USD on API calls
- **Time**: Complete within 5 days
- **Scope**: Focus on supervised learning; exclude RL and multimodal
- **Safety**: No training large models; use published data only

## Approach

### Phase 1: Literature Review (Days 1-2)

- Start with Kaplan et al. (2020) and Hoffmann et al. (2022)
- Follow citation graph to earlier work
- Ingest and summarize key papers

### Phase 2: Theoretical Understanding (Day 3)

- Extract mathematical formulations
- Identify assumptions and boundary conditions
- Map relationships between different scaling laws

### Phase 3: Empirical Validation (Day 4)

- Design experiments to reproduce key findings
- Use small models and public datasets
- Compare results to published curves

### Phase 4: Synthesis (Day 5)

- Generate wiki pages for concepts and researchers
- Write comprehensive report
- Identify open questions for future work

## Exploration Strategy

- **Depth-first on core papers**: Spend time on foundational work
- **Breadth on applications**: Survey how scaling laws are used
- **Hypothesis-driven experiments**: Test specific predictions
- **Stop when diminishing returns**: If 3 papers say the same thing, move on

## Deliverables

1. **Wiki Pages**: 15-20 pages covering papers, concepts, and researchers
2. **Report**: `scaling-laws-synthesis.md` with math, graphs, and insights
3. **Experiments**: 2-3 documented experiments with code and results
4. **Ideas**: List of 5 follow-up research questions

## Notes

This builds on previous work understanding transformers. Focus on the empirical side; defer deep theory to future missions.
```

## Example 2: Implementation Mission

```markdown
# Mission: Add Vector Search to Wiki Compiler

**Status**: Draft  
**Budget**: $20 USD  
**Duration**: 3 days  
**Priority**: Medium

## Objective

Integrate vector search into the wiki compiler to enable semantic retrieval over large knowledge bases (1000+ pages). The goal is to replace or augment the current index-based search with embeddings.

## Success Criteria

1. **Integration**: qmd or similar tool integrated into compiler
2. **Performance**: Search returns relevant results in <500ms
3. **Coverage**: All wiki pages indexed with embeddings
4. **Tests**: 10 test queries with >80% relevance
5. **Documentation**: Updated README and CLI help

## Constraints

- **Budget**: $20 USD for experimentation
- **Time**: 3 days
- **Scope**: Read-only integration first; no UI changes
- **Compatibility**: Must work with existing file structure

## Approach

### Phase 1: Research (Day 1 AM)

- Survey vector search tools (qmd, txtai, Chroma)
- Evaluate embedding models (API vs local)
- Choose best fit for our use case

### Phase 2: Implementation (Day 1 PM - Day 2)

- Integrate chosen tool into compiler
- Add embedding generation step to compile workflow
- Update search API to use vectors

### Phase 3: Testing (Day 3 AM)

- Create test queries covering different concepts
- Measure precision and recall
- Compare to baseline index search

### Phase 4: Documentation (Day 3 PM)

- Update CLI commands
- Document configuration options
- Write migration guide

## Exploration Strategy

- **Fast prototyping**: Get a working version in 4 hours
- **Iterate on quality**: Tune parameters based on test results
- **Prefer simple solutions**: Local embeddings over API if possible

## Deliverables

1. **Code**: Vector search integration in `src/search/`
2. **Tests**: Test suite in `tests/search.test.ts`
3. **Docs**: Updated README and `docs/vector-search.md`
4. **Benchmark**: Performance comparison table

## Notes

This is a prerequisite for scaling to 1000+ wiki pages. Current index-based search works fine up to ~200 pages but degrades after that.
```

## Best Practices

### 1. Be Specific

❌ "Learn about AI agents"  
✅ "Understand how ReAct agents decompose complex tasks into steps, with 5 paper summaries and 2 working examples"

### 2. Make Success Measurable

❌ "Get a good understanding"  
✅ "Generate wiki pages for 10 key concepts with definitions, examples, and citations"

### 3. Set Conservative Budgets

Start low and increase if needed. Better to run multiple short missions than one that burns the budget without learning when to stop.

### 4. Define Constraints Explicitly

The agent will optimize for success criteria. Constraints prevent it from taking shortcuts (like spending $1000 or running for weeks).

### 5. Provide Exploration Strategy

Agents can explore breadth-first, depth-first, hypothesis-driven, or opportunistic. Guide the strategy based on your goals.

### 6. Specify Deliverables Clearly

Abstract outputs like "understanding" are hard to hand off. Concrete deliverables (wiki pages, reports, code) can be reviewed and built upon.

## Mission Status

- **Draft**: Not yet started
- **Active**: Currently being explored
- **Paused**: Temporarily stopped (can resume)
- **Completed**: Success criteria met
- **Abandoned**: Stopped without completion

Status is tracked in `.agent-state.json` and updated automatically.

## Mission Metadata

The agent parser extracts:

- Title
- Status
- Budget
- Duration
- Priority
- Maximum iterations
- Objective (first paragraph after "## Objective")
- Success criteria (list items)
- Constraints (list items)

Both `## Success Criteria` and `## Success Metrics` are accepted. List items
may use bullets or numbered Markdown. Numeric targets support `>=`, `<=`, `>`,
`<`, `=`, `≥`, and `≤`.

This metadata is used to track progress and make decisions about resource allocation.

## Tips

- **Start Small**: First mission should be 1-2 days, $10-20 budget
- **Iterate**: Review results and launch follow-up missions
- **Link Missions**: Reference prior missions in notes
- **Version Control**: Mission documents live in Git, so you have history
- **Multiple Missions**: Can run several in parallel (with separate budgets)

## Anti-Patterns

❌ **Vague Objectives**: "Explore AI" → What aspect? For what purpose?  
❌ **No Success Criteria**: Agent doesn't know when to stop  
❌ **Unbounded Scope**: "Everything about X" → Define boundaries  
❌ **Process-Only**: "Read 10 papers" → What should the agent *produce*?  
❌ **Too Ambitious**: 50-page report in 1 day → Set realistic goals
