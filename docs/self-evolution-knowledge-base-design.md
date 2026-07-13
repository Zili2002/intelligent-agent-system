# 自进化知识库系统方案

> **实现状态（0.2.0）**：摄入、编译、查询、lint、结构化反思、gaps、
> Crossref 主动搜索、有限 learn 循环、实验 provenance 和知识图谱已经实现。
> “提炼模式、自动构建可执行工具、修改 schema”仍属于受控提案，不会未经
> 审批直接执行或推送。这里的自进化指知识与策略积累，不训练基础模型权重。

## 核心扩展理念

在 LLM Wiki 的基础上，自进化系统需要三个额外能力：

1. **自我反思**：智能体能评估自己的知识质量、识别知识缺口
2. **主动学习**：根据反思结果，主动规划需要补充的知识
3. **能力提升**：不仅积累知识内容，还要提炼可复用的推理模式和工具

## 架构设计（四层）

```
raw/              # 原始资料层（不变）
├── papers/
├── articles/
└── data/

wiki/             # 知识层（扩展）
├── entities/     # 实体页面
├── concepts/     # 概念页面
├── methods/      # 方法论页面（新增）
├── patterns/     # 推理模式库（新增）
└── tools/        # 工具脚本（新增）

meta/             # 元认知层（新增）
├── knowledge_graph.json    # 知识图谱
├── capability_map.md       # 能力地图
├── gaps.md                 # 知识缺口清单
├── evolution_log.md        # 进化日志
└── reflection/             # 反思记录
    ├── 2026-07-09_contradictions.md
    └── 2026-07-08_coverage_analysis.md

schema/           # 配置层（扩展）
├── CLAUDE.md               # 基础schema
├── evolution_rules.md      # 进化规则
└── quality_metrics.md      # 知识质量标准
```

## 关键操作扩展

### 1. Reflect（反思）
智能体定期执行自我检查：

- 扫描 wiki，识别：
  - 矛盾声明（contradictions）
  - 知识孤岛（isolated pages）
  - 薄弱领域（thin coverage areas）
  - 重复内容（redundancies）
- 生成 `meta/gaps.md`，列出缺失的：
  - 关键概念
  - 方法论
  - 验证数据
- 评估现有推理模式的成功率（从 `log.md` 中统计）

**输出**：`meta/reflection/YYYY-MM-DD_reflection.md`

### 2. Plan Learning（规划学习）
基于反思结果，生成学习计划：

```markdown
# Learning Plan 2026-07-09

## Priority 1: Fill knowledge gaps
- [ ] 查找关于 X 概念的论文（发现多处引用但无专门页面）
- [ ] 补充 Y 方法的实验数据（当前仅有理论描述）

## Priority 2: Resolve contradictions
- [ ] 调研 A vs B 的争议（wiki 中有两个冲突声明）

## Priority 3: Extract patterns
- [ ] 从最近 10 次成功推理中提取共同模式
```

智能体可以：
- 主动触发 web 搜索
- 请求用户提供特定类型的资料
- 重新分析已有资料以提取遗漏信息

### 3. Extract Patterns（提炼模式）
从成功的查询和推理中提取可复用模式：

```markdown
# Pattern: 多源验证法
**场景**：评估一个有争议的声明
**步骤**：
1. 在 wiki 中查找该声明的所有来源
2. 检查来源的时间、权威性、是否同行评审
3. 查找反驳证据
4. 综合判断并标注置信度

**成功案例**：2026-07-05 关于 X 技术的可行性评估
**适用条件**：至少有 3 个独立来源
```

保存到 `wiki/patterns/multi_source_verification.md`，未来遇到类似问题时优先调用。

### 4. Build Tools（构建工具）
将重复任务自动化：

```python
# wiki/tools/citation_checker.py
"""检查 wiki 中所有引用链接的有效性"""
def check_citations(wiki_dir):
    # 扫描所有 .md 文件
    # 提取 URL
    # 验证可达性
    # 生成报告
```

工具由智能体编写，添加到执行环境，成为自己的能力扩展。

### 5. Evolve Schema（演化规则）
`schema/evolution_rules.md` 本身也会更新：

```markdown
# Evolution Rules v2.3

## 新增规则（2026-07-09）
- **自动质量评分**：每个 wiki 页面添加 frontmatter：
  ```yaml
  quality_score: 0.85
  source_count: 7
  last_verified: 2026-07-09
  confidence: high
  ```
- **主动验证触发**：当页面 source_count < 3 且被引用超过 5 次时，
  自动将其加入 learning plan
```

## 自进化工作流示例

```
[用户] 摄入一篇新论文关于强化学习

[智能体执行 Ingest]
→ 创建 wiki/papers/rl_paper_2026.md
→ 更新 wiki/concepts/reinforcement_learning.md
→ 发现矛盾：新论文声称方法 A 优于 B，但 wiki 中已有声明相反
→ 在 meta/gaps.md 中标记："需要更多证据比较 A vs B"

[定期 Reflect 触发]
→ 分析 gaps.md
→ 生成学习计划：搜索最近关于 A vs B 的综述
→ 主动调用 web_search 工具

[找到综述后 Ingest]
→ 更新对比页面 wiki/concepts/method_a_vs_b.md
→ 解决矛盾，标注不同场景下的适用性
→ 从此次解决过程中提取模式："方法对比模板"
→ 保存到 wiki/patterns/method_comparison_template.md

[下次遇到类似冲突]
→ 自动调用 method_comparison_template 模式
→ 效率提升，质量更一致
```

## 自进化的度量指标

在 `meta/capability_map.md` 中追踪：

```markdown
# Capability Evolution

## Knowledge Metrics
- Total pages: 243 (+15 this week)
- Average quality score: 0.82 (+0.05)
- Contradiction count: 3 (-7)
- Orphan pages: 5 (-2)

## Capability Metrics
- Extracted patterns: 12 (+3)
- Custom tools: 5 (+1)
- Average query resolution time: 23s (-8s)
- Self-directed learning tasks completed: 4

## Evolution Milestones
- 2026-07-01: 首次主动识别知识缺口
- 2026-07-05: 首次自主触发 web 搜索补充资料
- 2026-07-09: 构建第一个自动化检查工具
```

## 技术实现建议

### 1. 知识图谱
用 JSON 或 SQLite 维护实体/概念间的关系，便于：
- 查找孤岛
- 计算中心节点
- 追踪影响范围

### 2. 定时任务
```bash
# 每周日触发反思
0 0 * * 0 claude_code --project=/path/to/wiki "执行 Reflect 操作"
```

### 3. 版本控制
wiki 目录作为 git 仓库，每次重要更新都 commit，可以：
- 回溯知识演变历史
- 对比不同版本的理解

### 4. 质量门禁
在 `schema/quality_metrics.md` 中定义：
```markdown
# Quality Gates
- 新页面必须链接至少 2 个已有页面
- 声明必须注明来源
- 有争议的内容必须展示多方观点
```

## 与原 LLM Wiki 的区别

| 维度 | LLM Wiki | 自进化知识库 |
|------|----------|------------|
| 知识更新 | 被动（用户投喂） | 主动（发现缺口后自主搜索） |
| 质量保证 | 人工 lint | 自动反思+质量评分 |
| 能力增长 | 仅知识积累 | 知识+模式+工具三重增长 |
| 元认知 | 无 | 有专门的 meta 层 |

## 核心原则

这个方案的核心是：**不仅记住知识，还要学会如何更好地学习**。智能体通过不断反思自己的知识结构和推理过程，主动寻找提升方向，并将成功经验固化为可复用的模式和工具，形成正向循环。

## 参考资料

- 原始 LLM Wiki 理念文档
- https://github.com/atomicstrata/llm-wiki-compiler.git（待分析）
