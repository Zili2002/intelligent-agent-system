# 从 Academic Research Skills 项目中学到的关键点

基于对 https://github.com/Imbad0202/academic-research-skills 的分析

## 项目概述

Academic Research Skills (ARS) 是一个为 Claude Code 设计的综合学术研究技能套件，覆盖从研究到发表的完整流程。当前版本 v3.17.0。

## 核心架构特点

### 1. 多阶段管道设计（10-Stage Pipeline）

```
Stage 1: RESEARCH (deep-research)
Stage 2: WRITE (academic-paper)
Stage 2.5: INTEGRITY CHECK (mandatory gate)
Stage 3: PEER REVIEW
Stage 3': RE-REVIEW (if needed)
Stage 4: REVISE
Stage 4.5: INTEGRITY CHECK (mandatory gate)
Stage 5: FINALIZE
Stage 6: PROCESS SUMMARY
```

**可借鉴点**：
- **强制门禁设计**：Stage 2.5 和 4.5 的完整性验证无法跳过
- **渐进式检查点**：FULL（完整确认）/ SLIM（快速确认）/ MANDATORY（强制）
- **Material Passport**：贯穿整个流程的元数据传递机制

### 2. Human-in-the-Loop 而非全自动化

```markdown
> "AI is your copilot, not the pilot."
```

**设计理念**：
- AI 处理繁琐工作（格式化、引用检查、逻辑一致性）
- 人类负责核心决策（问题定义、方法选择、数据解释）
- 每个关键阶段都需要人类确认

**可借鉴点**：
- 论文筛选不应完全自动化，AI 提供推荐，用户做最终决定
- 在高风险决策点（如拒绝论文）设置人工确认

### 3. 多 Agent 协作架构

**Deep Research (13 agents)**:
- Socratic Mentor（苏格拉底导师）
- Literature Analyzer（文献分析师）
- Synthesis Agent（综合代理）
- Bibliography Agent（文献管理）
- Risk of Bias Agent（偏差风险评估）
- Meta Analysis Agent（元分析）
- ...

**Academic Paper Reviewer (7 agents)**:
- Editor-in-Chief（主编）
- 3 × Domain Reviewers（领域审稿人）
- Devil's Advocate（魔鬼代言人，挑战论点）
- Editorial Synthesizer（编辑综合者）
- Collaboration Depth Observer（协作深度观察员）

**可借鉴点**：
- **Devil's Advocate 机制**：专门设置一个 agent 负责挑战和质疑
- **多视角评审**：不同 agent 从不同角度评估同一篇论文
- **Editorial Synthesizer**：独立的综合决策 agent，避免单一 agent 偏见

### 4. 对抗 AI 局限性的机制

#### a. Anti-Sycophancy（反谄媚）机制

```yaml
Devil's Advocate Concession Threshold:
  - 每个反驳必须先打分 1-5
  - 只有 ≥4 分才允许让步
  - 禁止连续让步
  - 追踪让步率
  - 检测 frame-lock（思维框架锁定）
```

**问题背景**：
- AI 倾向于在用户推回时过快让步
- "用户推回"被错误地当作"攻击点有误"的证据

**可借鉴点**：
- 在 AI Reviewer 中加入"反驳评分机制"
- 防止 AI 因用户不满而随意修改评分

#### b. Intent Detection Layer（意图检测层）

```yaml
分类用户意图:
  exploratory: # 探索性
    - 禁用自动收敛
    - 最大轮数提升至 60
    - 禁止"要我总结吗？"提示

  goal_oriented: # 目标导向
    - 标准收敛行为
    - 主动推进交付
```

**可借鉴点**：
- 论文阅读器应检测用户是"深度探索"还是"快速筛选"
- 根据意图调整交互模式

#### c. Dialogue Health Indicator（对话健康指标）

```yaml
每 5 轮静默自检:
  - persistent_agreement（持续同意）
  - conflict_avoidance（冲突回避）
  - premature_convergence（过早收敛）

检测到问题 → 自动注入挑战性问题
```

**可借鉴点**：
- 在长期使用中监测 AI Reviewer 的评分模式
- 如果连续多篇都给高分/低分，触发校准检查

### 5. 引用完整性验证系统（v3.9-v3.11）

#### 三层引用锚点系统（v3.7.3）

```html
<!--ref:Smith2024-->
<!--anchor:quote:The%20attention%20mechanism%20enables...-->
<!--anchor:page:42-->
<!--anchor:section:3.2-->
```

**三层定位**：
1. **quote**（引文，上限 25 词，URL 编码）
2. **page**（页码）
3. **section**（章节）

#### 确定性验证门禁（v3.11.0）

```python
四重索引验证:
  - Semantic Scholar API
  - OpenAlex API
  - Crossref API
  - arXiv resolver（无需 API key）

验证状态:
  - lookup_verified: true   # 四个数据库中至少一个确认
  - lookup_verified: false  # ID 明确但查无此文（疑似伪造）
  - lookup_verified: unresolvable  # 未被索引（人文/非英语/地区性期刊）
```

**可借鉴点**：
- **多源交叉验证**：不依赖单一数据库
- **保守策略**：未索引 ≠ 伪造，避免误伤小众领域文献
- **持久化缓存**：SQLite 缓存，90 天 TTL

#### 污染信号检测（v3.7.3）

```yaml
contamination_signals:
  preprint_post_llm_inflection: true  # 预印本晚于 2023 年
  semantic_scholar_unmatched: true    # S2 未匹配
  openalex_unmatched: true            # OpenAlex 未匹配
  crossref_unmatched: true            # Crossref 未匹配

k = 未匹配数据库数（0-3）
k=3 → 高度可疑
k=0 → 可信
```

**动机**：Zhao et al. (2026) 发现 2025 年有 146,932 条幻觉引用

**可借鉴点**：
- 在 AI Reviewer 中集成引用验证
- 自动标注可疑引用，但不直接拒稿（人工最终决策）

### 6. 时间完整性验证（v3.9.4）

**五类时间故障模式**：

```python
P1: 回顾性算术错误
    "2020 年数据显示 2025 年的趋势" ❌

P2: 时代错置引用
    "2018 年论文引用了 2022 年的研究" ❌

P3: 比较对象未实现
    "我们的 2020 方法优于 2023 的 SOTA" ❌

P4: 因果倒置
    "2026 年政策促成了 2020 年的推广" ❌

P5: 指代性现在时误用
    引用 2015 年论文用"目前"、"最近" ❌
```

**可借鉴点**：
- 在论文评审中加入时间逻辑检查
- 特别适用于快速发展领域（AI/ML）

### 7. 校准与质量保证

#### Reviewer Calibration Mode（v3.2）

```python
校准协议:
  - 用户提供 gold set（已知质量的论文集）
  - AI 评审这些论文
  - 计算 FNR（漏报率）/ FPR（误报率）
  - 5× ensembling（集成 5 次）
  - 跨模型验证（默认开启）
  - 会话范围的置信度披露
```

**可借鉴点**：
- 在部署 AI Reviewer 前，用已知论文集校准
- 定期重新校准，防止漂移

#### 质量门禁分级

```yaml
Tier 1 - MANDATORY（强制）:
  - 引用捏造 → 直接拒绝输出
  - 统计错误 → 直接拒绝输出

Tier 2 - HIGH-WARN（高警告）:
  - 声明与引用不符 → 拒绝输出（可用户覆盖）
  - 负面约束违反 → 拒绝输出（可用户覆盖）

Tier 3 - MED-WARN（中警告）:
  - 审计工具失败 → 建议重试

Tier 4 - ADVISORY（建议）:
  - 写作质量问题 → 仅提示
```

**可借鉴点**：
- 不同严重程度的问题采用不同处理策略
- 致命问题直接拒绝，次要问题仅提示

### 8. 跨模型验证（v3.0）

```bash
# 环境变量激活
export ARS_CROSS_MODEL=gpt-5.4  # 或 gemini-3.1-pro

交叉验证场景:
  - 完整性验证的抽样检查
  - Devil's Advocate 的独立批判
  - 最终编辑决策的盲审检查点
```

**风险分层采样**：
```python
HIGH-IMPACT 引用 → 100% 交叉验证（在两个门禁点）
MEDIUM-IMPACT 引用 → 30% 采样
LOW-IMPACT 引用 → 10% 采样
```

**可借鉴点**：
- 对高风险决策（拒稿、接收）使用不同模型交叉验证
- 成本优化：不是所有环节都交叉验证

### 9. 领域自适应机制

```python
DOMAIN_WEIGHTS = {
    'theoretical_cs': {
        'theory': 0.35,       # 理论研究最看重证明
        'experiments': 0.10   # 实验不强求
    },
    'applied_ml': {
        'experiments': 0.30,  # 应用研究看重实验
        'theory': 0.05        # 理论不强求
    },
    'systems': {
        'reproducibility': 0.30,  # 系统研究强调开源
        'theory': 0.05
    }
}
```

**特殊类型处理**：
- **Survey 论文**：novelty 权重降低，completeness 权重提升
- **Workshop 短文**：降低实验标准，允许初步结果
- **复现研究**：novelty 不重要，experiments 和 reproducibility 占主导

**可借鉴点**：
- AI Reviewer 应根据论文类型和领域调整评分标准
- 不要用统一标准评审所有论文

### 10. 文献管理与复用

#### Literature Corpus 输入端口（v3.6.4）

```yaml
# Material Passport 中的文献库
literature_corpus:
  - authors: [{family: "Vaswani", given: "Ashish"}]
    year: 2017
    title: "Attention Is All You Need"
    source_pointer:
      type: "doi"
      value: "10.5555/3295222.3295349"
    abstract: "..."  # 可选
    user_notes: "..."  # 可选
    contamination_signals:  # v3.7.3+
      preprint_post_llm_inflection: false
      semantic_scholar_unmatched: false
```

#### 语言中立适配器契约

```python
# 用户可以用任何语言编写适配器
# 只要输出符合 literature_corpus_entry.schema.json

官方提供的三个参考适配器:
  - folder_scan.py    # 扫描 PDF 文件夹
  - zotero.py         # 从 Zotero 导出
  - obsidian.py       # 从 Obsidian vault 提取
```

**可借鉴点**：
- 论文阅读器应支持从现有文献管理工具导入
- 提供标准 schema，用户可自己写适配器

### 11. 用户交互模式设计

#### Mode-Based Architecture（模式化架构）

**Deep Research (8 modes)**:
```
full              # 完整研究
quick             # 快速概览
systematic-review # PRISMA 系统综述
socratic          # 苏格拉底引导（最重要）
fact-check        # 事实核查
lit-review        # 文献综述
three-way-scan    # 三向对比（WHY/HOW/WHAT）
review            # 研究质量评审
```

**Academic Paper (11 modes)**:
```
full              # 完整写作
plan              # 引导规划（最重要）
outline-only      # 仅大纲
revision          # 修订
revision-coach    # 修订指导
abstract-only     # 仅摘要
lit-review        # 文献综述论文
format-convert    # 格式转换
citation-check    # 引用检查
disclosure        # AI 使用声明
rebuttal-audit    # 回复审稿意见审计
```

**Academic Paper Reviewer (6 modes)**:
```
full              # 完整评审（EIC + 3 Reviewers + DA）
quick             # 快速评估
guided            # 引导改进
methodology-focus # 方法论聚焦
re-review         # 重新评审
calibration       # 校准模式
```

**可借鉴点**：
- **Socratic / Plan 模式是核心创新**：引导式交互，而非直接输出
- 不同任务需要不同模式，而非"一刀切"
- 每个模式有清晰的触发条件和输出格式

#### Intent-Based Activation（基于意图的激活）

```python
# v2.6.2 引入，语言无关

检测信号:
  - "user is uncertain how to start" → plan mode
  - "user wants guided thinking" → socratic mode
  - "user has clear goal" → full mode

默认规则:
  当意图模糊时，优先 socratic/plan（引导优先）
```

**可借鉴点**：
- 不要依赖关键词匹配，而是理解用户意图
- 对不确定的用户，默认提供引导而非直接执行

### 12. 知识积累与传递

#### Material Passport（材料护照）

```yaml
# 贯穿整个流程的元数据
material_passport:
  version: "1.0"
  created_at: "2026-07-17T10:00:00Z"

  # Stage 1: RESEARCH 产出
  research_brief:
    research_questions: [...]
    methodology: "..."

  # Stage 2.5: INTEGRITY 产出
  integrity_verification:
    reference_check_results: [...]
    data_check_results: [...]

  # Stage 3: REVIEW 产出
  peer_review_summary:
    decision: "major_revision"
    reviewer_scores: [...]

  # 文献库（可跨会话复用）
  literature_corpus: [...]

  # 复现锁（可选）
  repro_lock:
    model: "claude-opus-4"
    temperature: 0.7
    prompt_version: "v3.17.0"
    # 注意：不保证字节级复现，仅记录配置
```

**可借鉴点**：
- 所有中间产物都记录到统一数据结构
- 跨会话恢复：用户可以从任何检查点继续
- 完整审计轨迹：知道每个决策的来源

#### Reset Boundary（重置边界，v3.6.3）

```bash
# 可选功能
export ARS_PASSPORT_RESET=1

效果:
  - 每个 FULL 检查点都是上下文重置边界
  - 可以在新会话中从 Material Passport 恢复
  - 防止长对话中的"上下文污染"
```

**可借鉴点**：
- 长期使用的论文阅读器需要考虑上下文管理
- 关键状态序列化到文件，随时可恢复

### 13. 成本与性能优化

```yaml
完整论文管道（15k 字）:
  总成本: $4-6

  按阶段分解:
    Stage 1 RESEARCH: ~$1.50
    Stage 2 WRITE: ~$2.00
    Stage 2.5 INTEGRITY: ~$0.30
    Stage 3 REVIEW: ~$1.00
    Stage 4 REVISE: ~$0.80
    Stage 4.5 INTEGRITY: ~$0.20
    Stage 5-6: ~$0.20

模型分层（v3.16.0，可选）:
  ARS_MODEL_TIERING=economy:
    执行型 agent → 降一档（Opus → Sonnet）
    判断型 agent → 保持原档

  ARS_MODEL_TIERING=quality-boost:
    执行型 agent → 保持原档
    判断型 agent → 提升至前沿档（Sonnet → Opus）
```

**可借鉴点**：
- 不是所有环节都需要最强模型
- 文献提取、格式转换 → 用便宜模型
- 质量判断、关键决策 → 用强模型

### 14. 失败模式与恢复

#### AI Research Failure Modes（Lu et al. 2026 Nature）

```yaml
7 种失败模式检查清单（Stage 2.5 / 4.5）:
  1. Implementation Bugs（实现错误）
  2. Hallucinated Results（幻觉结果）
  3. Shortcut Reliance（捷径依赖）
  4. Bug-as-Insight Reframing（把 bug 当发现）
  5. Methodology Fabrication（方法捏造）
  6. Frame-Lock（思维框架锁定）
  7. Citation Hallucinations（引用幻觉）

每个都有检测规则和恢复策略
```

**可借鉴点**：
- 预先识别 AI 可能出错的模式
- 针对性地设置检测机制

#### Graceful Degradation（优雅降级）

```python
# 示例：引用验证失败时的降级策略

if semantic_scholar_api_unavailable:
    # 降级 1：尝试其他 API
    try_openalex()
    try_crossref()

    if all_apis_unavailable:
        # 降级 2：手动验证模式
        return {
            'status': 'unresolvable',
            'reason': 'all_apis_unavailable',
            'suggestion': 'manual_verification_required'
        }
        # 不阻塞流程，标记为"需人工验证"
```

**可借鉴点**：
- 外部服务不可用时不应崩溃
- 降级到次优方案，并明确告知用户

### 15. 提示工程最佳实践

#### Iron Rules（铁律标记）

```markdown
## IRON RULE: [规则名称]

[明确的不可违反规则]

**为什么重要**: [解释]
**违反后果**: [说明]
```

**22 个 IRON RULE 分布**：
- 引用完整性（5 条）
- 数据验证（4 条）
- 评审独立性（3 条）
- 流程纪律（10 条）

**可借鉴点**：
- 长对话中 AI 容易"遗忘"关键规则
- 用醒目标记强化关键约束

#### Anti-Patterns（反模式表）

```markdown
| 反模式 | 为什么失败 | 正确行为 |
|--------|----------|---------|
| 用 AI 记忆验证引用 | AI 可能幻觉 | 必须用外部 API |
| 评审时修改论文 | 违反只读约束 | 仅提建议，不改文本 |
| 批量接受用户修改 | 谄媚行为 | 独立评估每条修改 |
```

**29 个反模式跨 4 个技能**

**可借鉴点**：
- 明确列出"不要做什么"
- 表格形式比纯文字更清晰

#### 认知框架引用（v3.1）

```markdown
不要写:
  "评估论文的论证质量"

而是引用框架:
  "使用 Toulmin 模型评估论证结构（见 argumentation_reasoning_framework.md）"

三个认知框架文件:
  - argumentation_reasoning_framework.md
  - review_quality_thinking.md
  - writing_judgment_framework.md
```

**可借鉴点**：
- 教 AI "如何思考"，而不只是"做什么"
- 大型提示词模块化：核心指令 + 引用参考文件

---

## 对我们系统的具体建议

### 论文阅读器方面

1. **采用 Material Passport 模式**
   - 每篇论文有唯一的"论文护照"
   - 记录：阅读状态、笔记、提取的实体、生成的 wiki 页面
   - 跨会话持久化

2. **多模式交互**
   ```
   quick-scan   # 3 分钟速读
   guided-read  # 苏格拉底式引导阅读（重要！）
   deep-dive    # 深度分析
   compare      # 与其他论文对比
   extract      # 提取到 wiki
   ```

3. **渐进式理解 + 检查点**
   ```
   Level 1: 速读摘要 → 用户确认是否继续
   Level 2: 精读核心 → 用户确认是否深入
   Level 3: 深度研读 → 用户确认是否编译到 wiki
   ```

4. **Devil's Advocate 阅读模式**
   - 专门挑战论文的论点
   - 帮助用户批判性思考
   - 避免盲目接受论文结论

### AI Reviewer 方面

1. **实现三级评审 + Devil's Advocate**
   ```
   Fast Filter (Haiku)
   Standard Review (Sonnet) + Devil's Advocate
   Deep Review (Opus, 可选)
   ```

2. **强制引用验证**
   - 集成 Semantic Scholar + OpenAlex + Crossref + arXiv
   - 三层锚点系统（quote + page + section）
   - 疑似伪造引用 → 高警告等级

3. **Anti-Sycophancy 机制**
   - 反驳评分（1-5）才允许修改评分
   - 追踪评分变化历史
   - 检测"用户推回就改分"模式

4. **校准模式**
   - 部署前用已知质量论文集校准
   - 定期重新校准
   - 跨模型验证高风险决策

5. **领域自适应**
   - 根据论文类型（理论/实证/系统/综述）调整权重
   - 不同会议/期刊有不同标准
   - 用户可自定义偏好

### arXiv 自动追踪方面

1. **三层筛选管道**
   ```
   Layer 1: 关键词/作者过滤（规则）
   Layer 2: 快速评审（Haiku，<2s/篇）
   Layer 3: 标准评审（Sonnet，<10s/篇，仅通过 Layer 2 的论文）
   ```

2. **智能调度**
   - 每天固定时间运行（避免 :00 和 :30，降低 API 负载）
   - 增量更新，不重复评审
   - 结果持久化到 SQLite

3. **用户反馈闭环**
   - 追踪用户对推荐的反应（阅读/跳过/标记优先）
   - 根据反馈调整权重
   - 个性化推荐算法

### 自进化知识库方面

1. **借鉴 Material Passport 的元数据传递**
   - 每次 ingest 生成"来源护照"
   - 记录：提取时间、AI 模型、质量评分、冲突检测

2. **Integrity Gates**
   - wiki 更新前的自动检查
   - 新信息与已有知识的矛盾检测
   - 引用链完整性验证

3. **跨会话恢复**
   - 知识库状态可序列化
   - 从任意检查点恢复工作
   - 支持多设备同步（已有方案）

---

## 总结：最值得借鉴的 5 个设计

1. **Human-in-the-Loop + 强制门禁**
   - AI 提供建议，人类做决策
   - 关键节点无法跳过人工确认

2. **Devil's Advocate 机制**
   - 专门的挑战角色
   - Anti-Sycophancy 规则
   - 反驳评分机制

3. **Material Passport 元数据传递**
   - 所有状态统一数据结构
   - 跨会话持久化
   - 完整审计轨迹

4. **多源引用验证**
   - 不依赖单一数据库
   - 三层锚点系统
   - 污染信号检测

5. **Socratic / Plan 引导模式**
   - 不直接输出答案，而是引导思考
   - Intent-based activation
   - 用户决定何时收敛

---

**文档版本**: 1.0
**分析日期**: 2026-07-17
**分析来源**: https://github.com/Imbad0202/academic-research-skills (v3.17.0)
