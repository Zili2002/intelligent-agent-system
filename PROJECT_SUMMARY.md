# 项目实现状态

## 当前能力

### 自主 Agent

- 解析 Mission Markdown，并用稳定 ID 保存 JSON 状态。
- 执行完整循环：
  `Orient → Hypothesize → Design → Safety/Approval → Execute → Analyze → Reflect → Decide`。
- 支持离线规则设计和可选 Anthropic 设计。
- 支持 Docker、local 和 hybrid 执行配置。
- local 模式默认只允许当前 Node 运行时；Docker 模式限制网络、能力、
  进程数、内存和 CPU。
- 记录实验代码、执行输出、`results.json`、分析和反思。
- 强制预算、审批和最大迭代限制。
- 支持中断实验恢复。

### 知识编译器

- 摄入 UTF-8 文本、Markdown、JSON、HTML、PDF 和 HTTP(S) 内容。
- 使用 SHA-256 去重并保存来源、URL、提供方、时间和媒体类型。
- 生成来源页、概念页、索引、日志、知识图谱、能力统计和知识缺口。
- 查询返回本地证据引用；无证据时不生成答案。
- lint 检查链接、frontmatter、来源引用、重复 slug 和薄弱页面。
- reflect 使用透明的结构/词法启发式识别覆盖不足、孤岛和潜在矛盾。
- search 使用 Crossref；learn 根据 gaps 执行有限搜索、摄入和重新编译。
- 支持注入搜索提供方，测试不访问网络。

### 跨仓库集成

- Agent 将已验证的实验结果以 `experiment` provenance 摄入 Wiki。
- 每次成功循环可自动 compile 和 reflect。
- 主动网络学习默认关闭，仅在配置或 CLI `--learn` 显式开启。
- `.agent-state.json` 使用锁和原子替换写入。
- onboard/handoff 默认仅本地操作；pull、commit、push 都是显式 opt-in。
- Git 分支自动检测，不再硬编码 `main` 或 `wiki`。

## 安全默认

- 不自动推送代码或知识库。
- 不在测试中调用付费 API。
- 不把离线探针描述为领域实验成功。
- 不把反思启发式描述为已验证事实。
- 不允许生成代码启动子进程、访问网络、动态执行代码或路径穿越。

## 已验证

```bash
npm install
npm run build
npm test
npm run lint
```

端到端验证覆盖：

```text
Mission Markdown
→ Node local sandbox
→ results.json
→ analyze / reflect / decide
→ experiment provenance ingestion
→ wiki compile
→ cited query
→ wiki lint
→ .agent-state.json handoff summary
```

## 明确边界

- “学习”是知识、经验、策略和工具积累，不训练基础模型权重。
- Mission 专用实验设计在 LLM 模式下需要有效的 Anthropic 凭据。
- Crossref 是学术元数据搜索，不等同于任意网页搜索引擎。
- Docker 实现存在并进入 CI 构建，但本地环境没有 Docker，无法本地运行验证。
- 当前状态锁解决单机并发写入，不是分布式多 Agent 调度数据库。
