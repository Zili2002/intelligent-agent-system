# 快速开始

## 1. 克隆与构建

```bash
git clone git@github.com:Zili2002/intelligent-agent-system.git
git clone git@github.com:Zili2002/my-research-wiki.git

cd intelligent-agent-system
npm install
npm run build
npm test
```

仓库 `.npmrc` 已配置所需内部 npm 源。

## 2. 初始化知识库

```bash
node packages/llm-wiki-compiler/dist/cli.js \
  --root ../my-research-wiki init

node packages/llm-wiki-compiler/dist/cli.js \
  --root ../my-research-wiki lint
```

## 3. 初始化 Agent 工作区

可以直接使用仓库根目录，也可以使用独立工作区：

```bash
node packages/autonomous-agent/dist/cli.js \
  --root ./agent-workspace init
```

编辑 `agent-workspace/.agent-config.json`，或设置：

```bash
WIKI_PATH=../../my-research-wiki
```

`WIKI_PATH` 相对于 Agent 工作区解析。

## 4. 启动 Mission

```bash
node packages/autonomous-agent/dist/cli.js \
  --root ./agent-workspace \
  mission-start ./examples/missions/example-mission.md
```

命令输出稳定的 Mission ID。执行一次离线循环：

```bash
node packages/autonomous-agent/dist/cli.js \
  --root ./agent-workspace \
  explore <mission-id> --sandbox local --offline --approve
```

连续运行有限轮次：

```bash
node packages/autonomous-agent/dist/cli.js \
  --root ./agent-workspace \
  run <mission-id> --max-cycles 3 --sandbox local --offline --approve
```

离线模式只生成透明的通用探针，不伪装为领域结论。使用 Mission 专用 LLM
设计时，配置 `analysis.mode` 并提供 `ANTHROPIC_API_KEY`。

Local 模式不是文件系统沙箱，因此必须显式添加 `--approve`。传给实验进程的
环境变量经过白名单过滤，不包含 Anthropic API Key 等宿主机密钥。

## 5. 查询和主动搜索

```bash
node packages/llm-wiki-compiler/dist/cli.js \
  --root ../my-research-wiki \
  query "What evidence is available?"

node packages/llm-wiki-compiler/dist/cli.js \
  --root ../my-research-wiki \
  search "autonomous agent evaluation" --limit 3
```

只有添加 `--import` 才会摄入搜索结果。Agent 的 `--learn` 同样是显式网络
操作：

```bash
node packages/autonomous-agent/dist/cli.js \
  --root ./agent-workspace \
  explore <mission-id> --learn
```

## 6. 状态交接

```bash
# 仅读取本地状态
node packages/autonomous-agent/dist/cli.js --root ./agent-workspace onboard

# 仅本地 checkpoint
node packages/autonomous-agent/dist/cli.js --root ./agent-workspace handoff

# 显式 Git 操作
node packages/autonomous-agent/dist/cli.js \
  --root ./agent-workspace onboard --pull --pull-wiki
```

commit 和 push 也必须通过 handoff 的对应显式参数开启。
