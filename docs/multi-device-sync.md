# 多设备协作与上下文同步方案

## 问题陈述

在多台设备上迭代同一个智能体系统时，新启动的 agent 面临：
1. **无历史上下文**：不知道之前在其他设备上做了什么
2. **版本不一致**：代码、知识库、使命状态可能不同步
3. **重复工作**：可能重新执行已完成的实验
4. **决策冲突**：不同设备上的 agent 可能做出矛盾的改进

## 解决方案：状态快照 + Git 同步

### 核心设计

**状态快照文件 `.agent-state.json`**：
- 存储在项目根目录，随代码一起提交到 Git
- 记录最后一次运行的完整上下文
- 新 agent 启动时自动读取，老 agent 退出时自动更新

**内容结构**：
```typescript
interface AgentState {
  version: string;              // 状态格式版本
  lastUpdated: string;          // ISO 8601 时间戳
  device: string;               // 设备标识（hostname）
  session: {
    id: string;                 // 会话 ID
    startedAt: string;
    endedAt?: string;
  };
  
  mission: {
    id: string;                 // 当前使命 ID
    path: string;               // 使命文档路径
    status: "active" | "paused" | "completed";
    progress: {
      phase: string;            // 当前阶段
      completedTasks: string[]; // 已完成任务 ID
      nextActions: string[];    // 待办事项
    };
    budget: {
      limit: number;
      spent: number;
      currency: "USD" | "tokens";
    };
  };
  
  knowledge: {
    wikiPath: string;           // Wiki 目录路径
    lastCompileAt: string;
    sourceCount: number;
    pageCount: number;
    lastSyncCommit: string;     // Git commit hash
  };
  
  exploration: {
    hypothesesGenerated: number;
    experimentsRun: number;
    successfulExperiments: number;
    lastExperiment: {
      id: string;
      description: string;
      result: "success" | "failure" | "inconclusive";
      timestamp: string;
    };
  };
  
  evolution: {
    lastReflectionAt: string;
    knowledgeGaps: string[];    // 识别出的知识缺口
    proposedIdeas: string[];    // 生成的想法 ID
    improvements: Array<{
      type: "code" | "skill" | "prompt" | "config";
      description: string;
      appliedAt: string;
      commit: string;
    }>;
  };
  
  context: {
    keyFindings: string[];      // 重要发现摘要
    openQuestions: string[];    // 未解决的问题
    decisions: Array<{          // 重大决策记录
      question: string;
      decision: string;
      rationale: string;
      timestamp: string;
    }>;
    warnings: string[];         // 需要注意的问题
  };
  
  sync: {
    gitRemote: string;
    gitBranch: string;
    lastPullAt: string;
    lastPushAt: string;
    conflicts: Array<{
      file: string;
      resolvedAt?: string;
    }>;
  };
}
```

### 工作流

#### 1. Agent 启动时（onboard）

```typescript
// src/sync/onboard.ts

/**
 * Agent启动时的上下文同步流程
 */
export async function onboardAgent(): Promise<OnboardResult> {
  console.log("🔄 Syncing context from repository...\n");

  // 1. Git pull 最新状态
  try {
    execSync("git pull origin main", { stdio: "inherit" });
  } catch (error) {
    console.warn("⚠️  Git pull failed. Working with local state.");
  }

  // 2. 读取状态快照
  const statePath = path.join(process.cwd(), ".agent-state.json");
  let state: AgentState | null = null;

  if (fs.existsSync(statePath)) {
    state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    console.log(`📋 Loaded state from ${state.device} (${state.lastUpdated})\n`);
  } else {
    console.log("📋 No previous state found. Starting fresh.\n");
  }

  // 3. 同步知识库
  if (state?.knowledge.wikiPath) {
    const wikiDir = path.resolve(state.knowledge.wikiPath);
    if (fs.existsSync(path.join(wikiDir, ".git"))) {
      console.log("📚 Syncing knowledge base...");
      execSync("git pull origin wiki", { cwd: wikiDir, stdio: "inherit" });
    }
  }

  // 4. 生成上下文摘要
  const summary = state ? await generateContextSummary(state) : null;

  return {
    state,
    summary,
    isResume: state?.mission.status === "active",
  };
}

/**
 * 为新agent生成可读的上下文摘要
 */
async function generateContextSummary(state: AgentState): Promise<string> {
  const prompt = `
Based on this agent state snapshot, generate a concise handoff summary 
for a new agent taking over the work:

${JSON.stringify(state, null, 2)}

Focus on:
1. What was the last agent working on?
2. What progress was made?
3. What are the immediate next steps?
4. Any warnings or blockers?

Keep it under 200 words, in natural language.
  `.trim();

  return await callLLM(prompt); // 调用 LLM 生成摘要
}
```

#### 2. Agent 运行时（checkpoint）

```typescript
// src/sync/checkpoint.ts

/**
 * 定期保存状态快照（每完成一个关键任务后）
 */
export async function saveCheckpoint(updates: Partial<AgentState>): Promise<void> {
  const statePath = path.join(process.cwd(), ".agent-state.json");
  
  let state: AgentState;
  if (fs.existsSync(statePath)) {
    state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } else {
    state = createEmptyState();
  }

  // 合并更新
  state = deepMerge(state, updates);
  state.lastUpdated = new Date().toISOString();
  state.device = os.hostname();

  // 写入文件
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  console.log(`✅ Checkpoint saved at ${state.lastUpdated}`);
}

/**
 * 在关键操作后自动checkpoint
 */
export function withCheckpoint<T>(
  operation: () => Promise<T>,
  stateUpdate: Partial<AgentState>
): Promise<T> {
  return operation().then(async (result) => {
    await saveCheckpoint(stateUpdate);
    return result;
  });
}
```

#### 3. Agent 退出时（handoff）

```typescript
// src/sync/handoff.ts

/**
 * Agent退出前的状态移交
 */
export async function handoffAgent(reason: "completed" | "paused" | "error"): Promise<void> {
  console.log("\n🤝 Preparing handoff...\n");

  // 1. 最终状态快照
  await saveCheckpoint({
    session: {
      ...currentSession,
      endedAt: new Date().toISOString(),
    },
    mission: {
      ...currentMission,
      status: reason === "completed" ? "completed" : "paused",
    },
  });

  // 2. 提交状态到 Git
  try {
    execSync('git add .agent-state.json', { stdio: "inherit" });
    execSync(
      `git commit -m "chore: agent handoff (${reason}) from ${os.hostname()}"`,
      { stdio: "inherit" }
    );
    execSync('git push origin main', { stdio: "inherit" });
    console.log("✅ State pushed to remote");
  } catch (error) {
    console.error("⚠️  Failed to push state:", (error as Error).message);
  }

  // 3. 如果知识库有更新，也推送
  const wikiPath = currentState.knowledge.wikiPath;
  if (wikiPath && fs.existsSync(path.join(wikiPath, ".git"))) {
    try {
      const hasChanges = execSync(
        "git status --porcelain",
        { cwd: wikiPath, encoding: "utf-8" }
      ).trim();

      if (hasChanges) {
        execSync('git add .', { cwd: wikiPath, stdio: "inherit" });
        execSync(
          `git commit -m "docs: wiki update from ${os.hostname()}"`,
          { cwd: wikiPath, stdio: "inherit" }
        );
        execSync('git push origin wiki', { cwd: wikiPath, stdio: "inherit" });
        console.log("✅ Wiki pushed to remote");
      }
    } catch (error) {
      console.error("⚠️  Failed to push wiki:", (error as Error).message);
    }
  }

  console.log("\n✨ Handoff complete. Next agent can resume from this state.\n");
}
```

### 4. 集成到主流程

```typescript
// src/cli.ts

async function main() {
  try {
    // 启动时同步
    const { state, summary, isResume } = await onboardAgent();

    if (summary) {
      console.log("📖 Context from previous session:\n");
      console.log(summary);
      console.log("\n" + "=".repeat(60) + "\n");
    }

    // 如果是恢复会话，询问是否继续
    if (isResume && state) {
      const shouldResume = await confirm(
        `Resume mission "${state.mission.id}" from ${state.mission.progress.phase}?`
      );

      if (!shouldResume) {
        console.log("Starting fresh mission instead.");
      }
    }

    // 主流程...
    
    // 定期 checkpoint
    setInterval(() => {
      saveCheckpoint(getCurrentState());
    }, 5 * 60 * 1000); // 每5分钟

  } catch (error) {
    console.error("Fatal error:", error);
    await handoffAgent("error");
    process.exit(1);
  } finally {
    // 退出时移交
    await handoffAgent("completed");
  }
}
```

### 5. 冲突解决

**场景**：两台设备同时运行，状态文件冲突

```typescript
// src/sync/conflict-resolver.ts

/**
 * 自动解决 .agent-state.json 冲突
 */
export async function resolveStateConflict(): Promise<void> {
  const conflicts = execSync("git diff --name-only --diff-filter=U", {
    encoding: "utf-8",
  }).trim().split("\n");

  if (!conflicts.includes(".agent-state.json")) {
    return; // 不是状态文件冲突
  }

  console.log("⚠️  Detected state conflict. Resolving...");

  // 读取三个版本
  const base = execSync("git show :1:.agent-state.json", { encoding: "utf-8" });
  const ours = execSync("git show :2:.agent-state.json", { encoding: "utf-8" });
  const theirs = execSync("git show :3:.agent-state.json", { encoding: "utf-8" });

  const stateBase = JSON.parse(base);
  const stateOurs = JSON.parse(ours);
  const stateTheirs = JSON.parse(theirs);

  // 合并策略：取最新时间戳的版本，但合并 context 和 evolution
  const merged: AgentState = 
    new Date(stateOurs.lastUpdated) > new Date(stateTheirs.lastUpdated)
      ? stateOurs
      : stateTheirs;

  // 合并 context（都保留）
  merged.context.keyFindings = [
    ...new Set([
      ...stateOurs.context.keyFindings,
      ...stateTheirs.context.keyFindings,
    ]),
  ];

  merged.context.openQuestions = [
    ...new Set([
      ...stateOurs.context.openQuestions,
      ...stateTheirs.context.openQuestions,
    ]),
  ];

  // 写回
  fs.writeFileSync(".agent-state.json", JSON.stringify(merged, null, 2));
  execSync("git add .agent-state.json");
  execSync('git commit -m "chore: auto-resolve agent state conflict"');

  console.log("✅ Conflict resolved automatically");
}
```

### 6. CLI 命令

```bash
# 查看当前状态
llmwiki sync status

# 手动拉取最新状态
llmwiki sync pull

# 查看其他设备的历史记录
llmwiki sync history

# 强制重置状态（清空重新开始）
llmwiki sync reset
```

---

## 使用示例

### 设备 A（笔记本）

```bash
cd ~/intelligent-agent-system
git pull origin main  # 拉取最新代码

# Agent 自动读取 .agent-state.json
npm run explore mission-001.md

# 运行3小时后，agent 自动 checkpoint 并 push
```

### 设备 B（台式机，第二天）

```bash
cd ~/intelligent-agent-system
git pull origin main  # 拉取最新代码和状态

# Agent 启动，显示摘要：
# 📖 Context from previous session:
#
# The last agent (device: laptop-dell) was working on Mission 001:
# optimizing model inference speed. It completed Phase 1 (literature
# review) and generated 3 hypotheses. The next step is to run
# Experiment 002 in the sandbox. Budget: 45% used ($13.50 / $30).
#
# ============================================================
#
# Resume mission "mission-001" from Phase 2: Experimentation? (y/n)

# 选择 y，无缝继续工作
```

### 协作场景（两人同时工作）

```bash
# Person A：负责文献摄入
cd ~/intelligent-agent-system
git checkout -b feature/ingest-papers
llmwiki ingest paper1.pdf
llmwiki compile
git push origin feature/ingest-papers

# Person B：负责实验
cd ~/intelligent-agent-system
git checkout -b feature/run-experiments
npm run explore mission-001.md

# 定期合并
git checkout main
git pull origin main
git merge feature/ingest-papers
git merge feature/run-experiments
```

---

## 总结

这个方案提供：
✅ **无缝切换**：在任何设备上 `git pull` 即可接手工作  
✅ **零记忆负担**：LLM 自动生成上下文摘要，人类不需要记住细节  
✅ **防重复**：已完成的实验/任务会记录，不会重新执行  
✅ **冲突自愈**：自动合并状态文件冲突  
✅ **可追溯**：每次 handoff 都是一个 Git commit，完整历史可查  

核心是 **Git as single source of truth**：代码、知识库、运行状态都在 Git 里，任何设备拉取后都能完整恢复上下文。
