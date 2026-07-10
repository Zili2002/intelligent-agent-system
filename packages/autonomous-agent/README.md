# Autonomous Agent - Mission-Driven Exploration System

A self-evolving AI agent system that autonomously explores, learns, and improves based on high-level mission objectives.

## 🎯 What We Built (Phase 1)

We've successfully implemented the **basic exploration cycle** - the foundation of the autonomous agent system:

### Core Components

✅ **Mission Management**
- Parse mission markdown files
- Track progress and budget
- Manage checkpoints and metrics

✅ **Orient Engine**
- Analyze current situation
- Identify opportunities and risks
- Generate recommendations

✅ **Hypothesis Generator**
- Generate testable hypotheses from situation analysis
- Rank by confidence and potential impact

✅ **Experiment Designer**
- Design experiments to test hypotheses
- Generate executable code (Python templates)
- Plan experiment steps

✅ **CLI Interface**
- `mission-start` - Start a new mission
- `mission-status` - Check mission progress
- `orient` - Run situation analysis
- `explore` - Full exploration cycle

## 🚀 Quick Start

### Installation

```bash
cd ~/autonomous-agent
npm install
npm run build
```

### Usage

1. **Create a mission** (see `missions/active/test-mission-001.md`)
2. **Start the mission:**
   ```bash
   node dist/cli.js mission-start test-mission-001.md
   ```
3. **Run exploration cycle:**
   ```bash
   node dist/cli.js explore <mission-id>
   ```
4. **Check generated experiment:**
   ```bash
   cd experiments/<exp-id>
   python experiment.py
   ```

## 📁 Project Structure

```
autonomous-agent/
├── missions/                # Mission definitions
│   ├── active/             # Active missions
│   └── templates/          # Mission templates
├── experiments/            # Generated experiments
├── src/
│   ├── types/             # TypeScript type definitions
│   ├── mission/           # Mission parsing and management
│   │   ├── parser.ts      # Parse mission markdown
│   │   └── manager.ts     # Mission lifecycle
│   ├── exploration/       # Exploration engine
│   │   ├── orient.ts      # Situation analysis
│   │   ├── hypothesize.ts # Hypothesis generation
│   │   └── design.ts      # Experiment design
│   └── cli.ts             # Command-line interface
└── dist/                   # Compiled JavaScript
```

## 🔄 The Exploration Cycle

```
1. Orient    → Analyze current situation
2. Hypothesize → Generate testable hypotheses
3. Design    → Create experiment plan
4. Execute   → Run experiment (manual for now)
5. Analyze   → Extract insights (coming soon)
6. Reflect   → Update knowledge (coming soon)
7. Decide    → Next action (coming soon)
```

**Phase 1 Status:** Steps 1-3 complete ✅

## 📊 Example Output

```bash
$ node dist/cli.js explore mission-test-autonomous-exploration-system-mrdt0p2b

🚀 Starting exploration cycle...

[1/3] 🧭 Orient: Analyzing current situation...
      Found 1 opportunities, 0 risks

[2/3] 💭 Hypothesize: Generating hypotheses...
      Generated 2 hypotheses
      1. Establishing baseline performance will reveal current system capabilities (90%)
      2. Fresh start - design exploratory baseline experiments (70%)

[3/3] 🔬 Design: Creating experiment for top hypothesis...
      ✅ Experiment designed: exp-1783619566603
      📁 Saved to: /home/linzili/autonomous-agent/experiments/exp-1783619566603
```

## 🎓 Key Concepts

### Mission-Driven Development
Instead of giving the agent specific tasks, you define:
- **Objective**: What success looks like
- **Constraints**: Time, resources, boundaries
- **Metrics**: How to measure success
- **Budget**: Resource limits

The agent autonomously decides HOW to achieve the objective.

### High-Density Context
All information lives in one repo:
- Missions in markdown
- Experiments as code
- Results as JSON
- No external dependencies

### Exploration Cycle
The agent continuously:
1. Analyzes where it is
2. Generates ideas
3. Designs experiments
4. Executes and learns
5. Adjusts strategy

## 🗓️ Roadmap

### ✅ Phase 1: Basic Exploration (COMPLETED)
- Mission parser
- Orient analysis
- Hypothesis generation
- Experiment design
- CLI commands

### 🔄 Phase 2: Execution & Safety (Next)
- Docker sandbox
- Experiment execution
- Result analysis
- Reflection engine
- Budget tracking

### 📅 Phase 3: Autonomous Learning
- Web search integration
- Knowledge base integration
- Auto-ingest pipeline
- Cron-based exploration

### 📅 Phase 4: Self-Evolution
- Performance analysis
- Capability improvement
- Code self-modification
- Graceful restart

## 🧪 Testing

Run the test mission:

```bash
# Start test mission
node dist/cli.js mission-start test-mission-001.md

# Get mission ID from output, then explore
node dist/cli.js explore mission-test-autonomous-exploration-system-<id>

# Check generated experiment
ls experiments/
```

## 📚 Documentation

- [Full Design Document](../mission-driven-autonomous-agent-system.md)
- [Implementation Report](../自进化知识库系统-实现完成报告.md)

## 🎉 Achievement Unlocked

We've built the **foundation for autonomous exploration**:
- ✅ Parses high-level missions
- ✅ Analyzes situation autonomously
- ✅ Generates hypotheses
- ✅ Designs experiments
- ✅ Generates executable code

**Next:** Make it actually execute and learn! 🚀

---

**Created:** 2026-07-10  
**Status:** Phase 1 Complete  
**Author:** Claude Code (Fable 5)
