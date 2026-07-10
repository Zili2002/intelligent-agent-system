# Intelligent Agent System

A self-evolving autonomous agent system with mission-driven exploration and knowledge compilation.

## 🚀 Features

- **Mission-Driven Exploration**: Define objectives, constraints, and success metrics; the agent explores autonomously
- **Knowledge Compilation**: Automatically build and maintain interconnected wiki from raw sources
- **Self-Evolution**: Learn from experiments, reflect on gaps, propose new ideas
- **Sandboxed Execution**: Safe Docker-based environment for running experiments
- **Multi-Device Sync**: Work across devices with Git-based synchronization

## 📦 Packages

- [`autonomous-agent`](./packages/autonomous-agent) - Mission-driven exploration engine
- [`llm-wiki-compiler`](./packages/llm-wiki-compiler) - Knowledge base compiler with evolution capabilities

## 🏃 Quick Start

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run autonomous agent
cd packages/autonomous-agent
npm run dev -- explore mission.md

# Compile knowledge base
cd packages/llm-wiki-compiler
npm run dev -- compile
```

## 📖 Documentation

- [Architecture Overview](./docs/architecture.md)
- [Deployment Guide](./docs/deployment.md)
- [Mission Document Format](./docs/mission-format.md)

## 🔧 Development

```bash
# Format code
npm run format

# Type check
npm run build

# Run tests
npm test
```

## 📄 License

MIT
