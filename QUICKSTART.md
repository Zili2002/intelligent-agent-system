# 快速开始指南

## 5 分钟上手

### 1. 克隆仓库

```bash
# 克隆主系统
git clone https://github.com/Zili2002/intelligent-agent-system.git
cd intelligent-agent-system

# 克隆知识库
cd ..
git clone https://github.com/Zili2002/my-research-wiki.git
```

### 2. 安装依赖

```bash
cd intelligent-agent-system
npm install
```

### 3. 配置环境变量

```bash
# 创建 .env 文件
cat > .env << 'EOF'
ANTHROPIC_API_KEY=your_api_key_here
WIKI_PATH=../my-research-wiki
EOF
```

### 4. 查看当前状态

```bash
# 查看 agent 状态
cat .agent-state.json | jq '.'

# 或使用更友好的查看方式
cat .agent-state.json | jq '{
  device: .device,
  lastUpdated: .lastUpdated,
  mission: .mission.status,
  budget: .mission.budget,
  nextActions: .mission.progress.nextActions
}'
```

输出示例：
```json
{
  "device": "initial-setup",
  "lastUpdated": "2026-07-11T00:00:00.000Z",
  "mission": "paused",
  "budget": {
    "limit": 100,
    "spent": 0,
    "currency": "USD"
  },
  "nextActions": [
    "Define first research mission",
    "Ingest initial sources into wiki",
    "Run first autonomous exploration"
  ]
}
```

### 5. 在 Obsidian 中打开知识库（可选但推荐）

1. 打开 Obsidian
2. "Open folder as vault"
3. 选择 `~/my-research-wiki/wiki`
4. 安装推荐插件：
   - Graph view（查看知识图谱）
   - Dataview（查询元数据）
   - Marp（生成幻灯片）

## 第一个使命

### 创建使命文档

```bash
cd intelligent-agent-system
cat > my-first-mission.md << 'EOF'
# Mission: Learn About LLM Agents

**Status**: Draft  
**Budget**: $10 USD  
**Duration**: 1 day  
**Priority**: High

## Objective

Understand the basics of LLM-based autonomous agents through a small literature review. Focus on ReAct, tool use, and self-improvement patterns.

## Success Criteria

1. **Sources**: At least 3 papers or articles ingested
2. **Wiki**: 5-10 pages covering key concepts
3. **Summary**: One synthesis document
4. **Ideas**: 3 follow-up research questions

## Constraints

- **Budget**: Maximum $10 USD
- **Time**: Complete in 1 day
- **Scope**: Focus on architecture, not applications

## Approach

### Phase 1: Search and Ingest (2 hours)

- Search for papers on ReAct, AutoGPT, agent architectures
- Ingest 3-5 high-quality sources
- Extract key concepts

### Phase 2: Compile and Link (1 hour)

- Generate wiki pages for concepts
- Cross-reference between pages
- Build concept map

### Phase 3: Synthesize (1 hour)

- Write synthesis document
- Identify knowledge gaps
- Generate follow-up questions

## Exploration Strategy

- Breadth-first: Survey multiple approaches
- Hypothesis-driven: Test specific claims
- Stop early if budget low

## Deliverables

1. **Wiki pages** for key concepts
2. **Synthesis document** (2-3 pages)
3. **Follow-up questions** list

## Notes

This is a learning mission to validate the system.
EOF
```

### 添加初始源文档

```bash
# 下载一篇示例论文（ReAct paper）
cd ../my-research-wiki/raw
curl -o react-paper.pdf "https://arxiv.org/pdf/2210.03629.pdf"

# 或者手动添加你感兴趣的文章/论文
```

### 运行 Agent（当核心功能实现后）

```bash
cd ~/intelligent-agent-system/packages/autonomous-agent

# 开发模式（实时编译）
npm run dev -- explore ../../my-first-mission.md

# 或生产模式
npm run build
npm run start -- explore ../../my-first-mission.md
```

Agent 会：
1. 加载状态快照
2. 显示上下文摘要
3. 提示是否继续之前的使命或开始新使命
4. 开始探索循环
5. 定期 checkpoint
6. 退出时自动提交状态

## 在另一台设备上继续工作

### Device B

```bash
# 拉取最新状态
cd ~/intelligent-agent-system
git pull origin master

# 启动 agent
cd packages/autonomous-agent
npm run dev -- explore

# Agent 显示：
# 📋 Loaded state from your-laptop (2 hours ago)
# 
# 📖 Context from previous session:
# ...
#
# Resume mission "Learn About LLM Agents" from Phase 2? (y/n)
```

选择 `y` 无缝继续。

## 手动同步状态

如果需要手动操作状态：

### 查看状态历史

```bash
cd ~/intelligent-agent-system
git log --oneline .agent-state.json
```

### 强制重置状态

```bash
# 备份当前状态
cp .agent-state.json .agent-state.backup.json

# 恢复到某个历史版本
git checkout <commit-hash> .agent-state.json

# 或完全重置（清空状态）
cat > .agent-state.json << 'EOF'
{
  "version": "1.0.0",
  "lastUpdated": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "device": "$(hostname)",
  "session": {"id": "fresh", "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"},
  "mission": {"id": "", "path": "", "status": "paused", "progress": {"phase": "", "completedTasks": [], "nextActions": []}, "budget": {"limit": 0, "spent": 0, "currency": "USD"}},
  "knowledge": {"wikiPath": "", "lastCompileAt": "", "sourceCount": 0, "pageCount": 0, "lastSyncCommit": ""},
  "exploration": {"hypothesesGenerated": 0, "experimentsRun": 0, "successfulExperiments": 0},
  "evolution": {"lastReflectionAt": "", "knowledgeGaps": [], "proposedIdeas": [], "improvements": []},
  "context": {"keyFindings": [], "openQuestions": [], "decisions": [], "warnings": []},
  "sync": {"gitRemote": "", "gitBranch": "master", "lastPullAt": "", "lastPushAt": "", "conflicts": []}
}
EOF
```

### 手动编辑状态

```bash
# 使用 jq 编辑 JSON
cat .agent-state.json | jq '.mission.budget.spent = 15.0' > .agent-state.tmp.json
mv .agent-state.tmp.json .agent-state.json

# 提交更改
git add .agent-state.json
git commit -m "chore: manually adjust budget"
git push
```

## 常用命令速查

```bash
# 查看状态摘要
jq '{device, mission: .mission.status, budget: .mission.budget, nextActions: .mission.progress.nextActions}' .agent-state.json

# 查看关键发现
jq '.context.keyFindings[]' .agent-state.json

# 查看开放问题
jq '.context.openQuestions[]' .agent-state.json

# 查看已完成任务
jq '.mission.progress.completedTasks[]' .agent-state.json

# 查看探索统计
jq '.exploration' .agent-state.json

# 查看已应用的改进
jq '.evolution.improvements[]' .agent-state.json

# 查看最后一次实验
jq '.exploration.lastExperiment' .agent-state.json
```

## Wiki 常用命令（当实现后）

```bash
cd ~/intelligent-agent-system/packages/llm-wiki-compiler

# 摄入新源文档
npm run dev -- ingest ../../../my-research-wiki/raw/paper.pdf

# 编译 wiki
npm run dev -- compile

# 查询知识库
npm run dev -- query "What are the main challenges in agent design?"

# 健康检查
npm run dev -- lint

# 查看状态
npm run dev -- status
```

## Obsidian 使用技巧

### 查看知识图谱

1. 打开 Graph view (Ctrl+G 或 Cmd+G)
2. 观察页面之间的连接
3. 不同颜色代表不同类型（entities, concepts, sources）

### 使用 Dataview 查询

在任意 markdown 页面插入：

````markdown
```dataview
TABLE file.mtime as "Last Modified", sourceCount as "Sources"
FROM "concepts"
SORT file.mtime DESC
LIMIT 10
```
````

显示最近修改的 10 个概念页面。

### 查看活动日志

打开 `log.md`，可以看到所有摄入和编译操作的时间线。

## 故障排查

### 依赖安装失败

```bash
# 清理并重新安装
rm -rf node_modules package-lock.json
npm install
```

### TypeScript 编译错误

```bash
# 检查 TypeScript 版本
npx tsc --version

# 重新编译
npm run build
```

### Git 冲突

```bash
# 查看冲突文件
git status

# 如果是 .agent-state.json 冲突，系统会自动解决
# 或手动选择版本
git checkout --ours .agent-state.json   # 保留本地
git checkout --theirs .agent-state.json # 使用远程
```

### API 密钥错误

```bash
# 检查 .env 文件
cat .env

# 测试 API 连接
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-opus-4-8","max_tokens":10,"messages":[{"role":"user","content":"Hi"}]}'
```

## 下一步学习

1. 阅读 `docs/architecture.md` 了解系统架构
2. 阅读 `docs/mission-format.md` 学习如何定义使命
3. 阅读 `docs/multi-device-sync.md` 深入理解同步机制
4. 阅读 `docs/deployment.md` 了解云端部署选项
5. 查看 `PROJECT_SUMMARY.md` 了解未来路线图

## 获取帮助

- **文档**: https://github.com/Zili2002/intelligent-agent-system/tree/master/docs
- **Issues**: https://github.com/Zili2002/intelligent-agent-system/issues
- **示例**: https://github.com/Zili2002/intelligent-agent-system/tree/master/examples

---

**准备好了？开始探索吧！** 🚀
