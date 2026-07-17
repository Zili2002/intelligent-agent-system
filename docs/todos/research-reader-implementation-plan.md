# Research Reader 完整实现方案与原始目标覆盖审计

## 1. 文档目的

本文档把以下四份原始材料统一为一套可实施、可验证、与现有代码架构兼容的开发方案：

- `paper-reader-design.md`
- `paper-reader-with-arxiv-tracking.md`
- `ai-reviewer-system-design.md`
- `learnings-from-academic-research-skills.md`

本文档同时记录：

1. 最终产品边界。
2. 与现有 `intelligent-agent-system` 的集成方式。
3. 模块、数据契约、CLI、运行流程和测试要求。
4. 原始目标的逐项覆盖情况。
5. 有意调整、延期或排除的目标及其理由。

本文档是实施规格，不直接复制 Academic Research Skills 项目的提示词或实现。该项目当前采用 CC BY-NC 4.0 许可；本仓库继续采用 clean-room 方式，只吸收一般设计思想，并保留来源说明。

## 实施状态

截至 2026-07-16，Phase 0-8 的本地可验证范围已经实现：

- Shared Runtime、Reader Core、Tracking、Triage、OA 获取和报告。
- Fast/Standard/Deep Reviewer、精确证据、对抗审查、引用与时间完整性。
- Reading Session、笔记、问答、对比、Extract、反馈、Profile 和校准。
- Cron/Daemon、审批、恢复、健康、图谱、分析、留存和综述计划。
- localhost React/PDF.js Web、手写、可选语音转写和本地通知。
- Folder、Obsidian、Zotero、LaTeX、PubMed 和 Conference 适配器。

Google Scholar、实时社区平台以及邮件/Slack 实际发送仍受官方 API、用户凭据、目标账号和外部发送审批约束；系统只提供安全扩展契约，不伪造可用集成。

## 2. 最终目标

在现有证据级 Wiki 和自主研究 Agent 基础上，增加一个个人研究阅读系统：

```text
持续文献追踪
→ 有界候选筛选
→ 开放全文获取
→ 证据化论文评审
→ 阅读队列与报告
→ 渐进式交互阅读
→ 笔记、批注和理解检查
→ Wiki 知识编译
→ 用户反馈驱动的个性化
→ 知识缺口和后续研究建议
```

系统中的“自学习”是指更新以下持久化状态：

- 研究兴趣档案。
- 阅读偏好和优先级策略。
- Reviewer 校准参数。
- 阅读历史、理解状态和知识缺口。
- Wiki 中的证据、Claim、关系和研究主题。

系统不训练或修改基础模型权重，也不把用户点击行为伪装成经过验证的科学结论。

## 3. 核心原则

### 3.1 证据优先

- Reviewer 的每个事实性判断必须引用输入论文中的精确证据。
- 引文必须能够在 `SourceArtifact` 中确定性定位。
- 无法从当前输入验证的维度必须返回 `unknown`。
- Metadata-only、摘要、部分页面和全文必须明确区分。
- 证据置信度不是“结论为真的概率”。

### 3.2 Human-in-the-Loop

- 日常元数据追踪可以在明确配置后有界自动运行。
- 全文下载、付费 LLM、外部通知、知识编译和高影响判断具有独立审批边界。
- 用户可以覆盖推荐，但覆盖不会改写或删除旧 Review。
- 自动跳过的论文仍保留最小审计记录，可由用户恢复。

### 3.3 有界自治

- 每次运行限制候选数、LLM 候选数、全文下载数、Token、并发和运行时长。
- 复用现有 Evidence Frontier、重试、锁、熔断和生命周期机制。
- 不因一个订阅或一个模糊线索产生无限搜索扩展。

### 3.4 目标分离

必须分别表示：

1. 科学质量。
2. 输入和证据完整度。
3. 与用户研究的相关性。
4. 当前阅读优先级。
5. 用户阅读后的实际价值。

作者声望、机构、会议、引用数和社区热度不得直接进入科学质量分。

### 3.5 非回归

- Reader 默认关闭。
- 不改变现有 `llmwiki` 和 `autonomous-agent` 的默认行为。
- 不自动 commit、push、下载、调用付费模型或发送通知。
- 原始 Mission、Wiki、Claim Registry 和现有配置保持兼容。
- 开发和验证只在 `develop` worktree 中进行，当前 `master` 业务目录不切换分支。

## 4. 产品范围

### 4.1 首期交付范围

- 查询、分类、关键词和作者订阅。
- 本地 PDF/HTML/Markdown 批量导入。
- 可配置的语言偏好和语言过滤。
- arXiv、OpenAlex、Crossref 元数据追踪。
- 候选去重、版本识别和重抓保护。
- 本地语义预筛和有界 Fast Triage。
- Priority、Deep Read、Skim、Archive 队列。
- OA 全文获取。
- Fast、Standard、Deep 三层 Reviewer。
- 精确引文和页码/章节定位。
- Daily/Weekly 报告。
- Paper Passport、Reading Session 和用户反馈。
- Quick Scan、Guided Read、Deep Dive、Compare、Extract 阅读模式。
- Markdown 笔记和 Wiki 编译。
- 个性化研究档案和校准状态。
- CLI、调度、审批、运行历史和健康检查。

### 4.2 后续交付范围

- PDF Web 阅读器。
- 自动高亮、页内 AI 注释和证据跳转。
- 手写和语音笔记。
- 图表、公式和图片的多模态理解。
- 引用网络、方法演进、概念关系和时间线可视化。
- 阅读依赖树和推荐阅读路径。
- 知识留存检查、理解度和薄弱领域分析。
- 推理模式库。
- PubMed、Zotero、Obsidian、目录扫描和 LaTeX 适配器。
- 会议接收论文追踪。
- 可选社区信号。
- 本地通知和明确批准的外部通知。
- 团队协作和移动端。
- 可选 Docker/容器部署。

### 4.3 明确排除

- 未经官方授权抓取 Google Scholar。
- 绕过付费墙、登录、robots 或许可证限制。
- 用作者、机构或热度替代论文质量判断。
- 在测试中执行真实网络或付费模型调用。
- 自动向邮件、Slack 或公开平台发送内容。
- 从其他项目直接复制受非商业许可约束的提示词或代码。

Google Scholar 仍保留为产品愿景中的“可选导入来源”，但只有在存在官方、授权或用户自行提供的数据出口时才能实现。

## 5. 总体架构

```text
packages/shared
  └─ 通用锁、重试、原子持久化、JSONL、脱敏

packages/llm-wiki-compiler
  └─ Provider、全文、Source、Claim、证据、检索、Wiki 编译

packages/research-reader
  └─ 订阅、追踪、Triage、Reviewer、阅读、报告、档案、校准、调度

packages/autonomous-agent
  └─ Mission、实验和知识同步，保持现有职责

packages/research-reader-web
  └─ 后期增加的本地 PDF 阅读和交互界面
```

依赖关系：

```text
shared ← llm-wiki-compiler
shared ← research-reader → llm-wiki-compiler
shared ← autonomous-agent → llm-wiki-compiler
```

`research-reader` 不依赖 `autonomous-agent`。日常文献追踪不是实验 Mission，但两者可以通过 Wiki 和共享运行时能力交换知识。

## 6. 架构决策

### 6.1 新增独立 `research-reader` 包

理由：

- 阅读工作流不是 Wiki 编译器职责。
- 阅读队列、用户状态和报告不应污染 Claim 编译逻辑。
- 可以独立发布、测试和关闭。
- 避免 Reader 故障影响当前 Mission 业务。

### 6.2 继续使用 TypeScript

原始文档中的 Python 代码视为伪代码，不直接落地。当前仓库是 TypeScript monorepo，新功能继续使用 Node.js 和现有包：

- 避免维护第二套运行时。
- 复用现有 Provider、LLM、PDF、语义索引和测试基础设施。
- 避免 Python 与 TypeScript 状态模型不一致。

### 6.3 JSON/JSONL/Markdown 为权威状态

首期不使用 SQLite、Neo4j 或 ChromaDB：

- 当前系统要求 Git 可移植和人类可读。
- 每篇论文独立文件可减少写冲突。
- 现有 Claim Graph 和 MiniLM 已覆盖主要图和向量需求。
- JSONL 适合追加式反馈和运行事件。

未来如需本地查询加速，可以增加可重建缓存，但缓存不是权威数据。

### 6.4 结构化视角代替固定数量的多 Agent

原始材料提出多个 Reviewer、Devil's Advocate 和 Editorial Synthesizer。实现时保留这些独立视角和审计边界，但不要求每个视角都成为独立进程：

```text
Initial Review
→ Methodology Pass
→ Evidence Integrity Pass
→ Devil's Advocate Pass
→ Synthesis Pass
```

跨模型验证只用于高风险或高分歧样本，不使用“不同 temperature 等于独立评审”的错误替代。

## 7. 代码改造

### 7.1 `packages/shared`

新增：

```text
src/runtime/atomic-json.ts
src/runtime/file-lock.ts
src/runtime/retry.ts
src/runtime/jsonl.ts
src/runtime/redaction.ts
```

能力：

- 原子 JSON 写入。
- 追加式 JSONL。
- 通用文件锁和过期锁恢复。
- 有界指数重试。
- 运行日志脱敏。
- 受限路径解析。

现有 Agent 的锁、重试和持久化 API 保持兼容，内部逐步改为共享实现。

### 7.2 `packages/llm-wiki-compiler`

新增或抽取公共 API：

```text
src/literature-identity.ts
  canonicalLiteratureKey()
  mergeLiteratureRecords()

src/source-store.ts
  getSourceArtifact()
  listSourceArtifacts()

src/evidence.ts
  validateEvidenceQuote()
  validateEvidenceAnchor()

src/source-query.ts
  extractSourceSections()
  querySource()

src/acquire.ts
  acquireSearchResult()
```

保留在 Compiler 中的职责：

- Provider 搜索和规范化。
- DOI/arXiv/OpenAlex 去重。
- OA 全文获取。
- PDF/HTML/XML 文本解析。
- 页码和章节定位。
- Source、Claim 和证据校验。
- 矛盾、语义索引、Frontier 和 Wiki 编译。

### 7.3 `packages/research-reader`

```text
src/
├─ cli.ts
├─ service.ts
├─ config.ts
├─ types.ts
├─ store.ts
├─ identity.ts
├─ subscriptions.ts
├─ tracking.ts
├─ triage.ts
├─ acquisition.ts
├─ queue.ts
├─ reading.ts
├─ annotations.ts
├─ navigation.ts
├─ profile.ts
├─ feedback.ts
├─ calibration.ts
├─ reports.ts
├─ scheduler.ts
├─ approvals.ts
├─ adapters/
│  ├─ types.ts
│  ├─ folder.ts
│  ├─ zotero.ts
│  ├─ obsidian.ts
│  └─ pubmed.ts
└─ reviewer/
   ├─ fast.ts
   ├─ standard.ts
   ├─ deep.ts
   ├─ paper-type.ts
   ├─ coverage.ts
   ├─ evidence.ts
   ├─ citation-integrity.ts
   ├─ temporal-integrity.ts
   ├─ adversarial.ts
   └─ synthesis.ts
```

适配器在首期只定义稳定接口，具体实现按阶段添加。

### 7.4 `packages/research-reader-web`

后期新增：

- React。
- PDF.js。
- 仅监听 `127.0.0.1` 的本地服务。
- PDF 阅读、文本选择、批注、Review 卡片、报告和反馈。
- Paper-scoped 和 Corpus-scoped 问答。
- 引文点击后跳转到页码或章节。

## 8. 持久化布局

```text
meta/reader/
├─ subscriptions.json
├─ profile.json
├─ papers/
│  └─ <paper-id>.json
├─ reviews/
│  └─ <paper-id>/<review-id>.json
├─ reading-sessions/
│  └─ <session-id>.json
├─ annotations/
│  └─ <paper-id>.json
├─ patterns/
│  └─ <pattern-id>.md
├─ feedback.jsonl
├─ approvals/
├─ calibration/
│  ├─ benchmark.json
│  └─ evaluation.json
├─ runs/
│  ├─ <run-id>.json
│  ├─ history.jsonl
│  └─ locks/
└─ migrations/

reports/reader/
├─ daily/
├─ weekly/
└─ trends/

wiki/papers/
wiki/methods/
wiki/datasets/
wiki/comparisons/
```

队列由 Paper Passport 状态派生，不单独维护第二套真值。

可重建的向量或 UI 缓存放在本地 cache 目录，不作为 Git 权威状态。

## 9. 数据契约

### 9.1 Paper Passport

```ts
interface PaperPassport {
  version: 1;
  id: string;
  canonicalKey: string;
  sourceIds: string[];
  metadata: LiteratureMetadata;

  discovery: Array<{
    subscriptionId?: string;
    query: string;
    provider: string;
    runId: string;
    discoveredAt: string;
  }>;

  acquisition: {
    status: "metadata-only" | "available" | "failed";
    fullTextSourceId?: string;
    failureReason?: string;
  };

  triage?: {
    relevanceScore: number;
    confidence: number;
    difficultyEstimate?: number;
    recommendation:
      | "priority"
      | "deep-read"
      | "skim"
      | "archive"
      | "manual-review";
    reasons: string[];
    profileVersion: string;
    policyVersion: string;
  };

  reading: {
    status:
      | "unread"
      | "queued"
      | "reading"
      | "read"
      | "revisit"
      | "dismissed";
    priority: number;
    progress?: number;
    startedAt?: string;
    completedAt?: string;
    userTags: string[];
    userRating?: number;
    personalValue?: number;
    understandingScore?: number;
    notePath?: string;
  };

  reviewIds: string[];

  knowledge: {
    compiled: boolean;
    claimIds: string[];
    wikiPaths: string[];
    compiledAt?: string;
  };

  lifecycle: {
    latestVersionId?: string;
    reviewStale: boolean;
    retracted: boolean;
    supersededBy?: string;
  };

  createdAt: string;
  updatedAt: string;
}
```

身份优先级：

```text
DOI
→ arXiv 基础 ID
→ OpenAlex ID
→ 标题 + 年份 + 第一作者指纹
```

arXiv 版本单独记录，新版本更新原有 Passport。

### 9.2 Paper Review

```ts
interface EvidenceAnchor {
  sourceId: string;
  quote: string;
  page?: number;
  section?: string;
  start?: number;
  end?: number;
}

interface DimensionAssessment {
  state: "assessed" | "unknown" | "not-applicable";
  score?: number;
  confidence: number;
  rationale: string;
  evidence: EvidenceAnchor[];
}

interface PaperReview {
  version: 1;
  id: string;
  paperId: string;
  sourceId: string;
  sourceVersion?: string;
  level: "fast" | "standard" | "deep";
  paperType: "empirical" | "theoretical" | "survey" | "systems" | "other";

  coverage: {
    fullText: boolean;
    sections: string[];
    pages: number[];
    coverageScore: number;
  };

  dimensions: {
    importance: DimensionAssessment;
    novelty: DimensionAssessment;
    methodology: DimensionAssessment;
    experiments: DimensionAssessment;
    reproducibility: DimensionAssessment;
    writing: DimensionAssessment;
    theory: DimensionAssessment;
    completeness?: DimensionAssessment;
    organization?: DimensionAssessment;
  };

  scientificQuality?: number;
  evidenceConfidence: number;
  personalRelevance: number;
  recommendation: "priority" | "deep-read" | "skim" | "archive";
  estimatedReadMinutes?: number;

  strengths: string[];
  weaknesses: string[];
  criticalIssues: string[];
  prerequisites: string[];
  readingRoute: string[];
  adversarialChallenges: string[];
  unresolvedChallenges: string[];

  model: string;
  promptVersion: string;
  usage: LlmUsage;
  createdAt: string;
}
```

重新评审生成新记录，旧记录不可变。

### 9.3 Reading Session

Reviewer 层级和用户阅读模式是两套不同概念，不得混用。

```ts
interface ReadingSession {
  version: 1;
  id: string;
  paperId: string;
  sourceVersion?: string;
  mode:
    | "quick-scan"
    | "guided-read"
    | "deep-dive"
    | "compare"
    | "extract";
  intent: "exploratory" | "goal-oriented";
  status: "active" | "paused" | "completed";
  checkpoints: Array<{
    level: 1 | 2 | 3;
    completedAt?: string;
    userConfirmed: boolean;
  }>;
  progress: {
    page?: number;
    section?: string;
    percent?: number;
  };
  questions: Array<{
    question: string;
    answer?: string;
    citations: EvidenceAnchor[];
  }>;
  selfAssessment?: {
    understanding: number;
    unresolvedQuestions: string[];
  };
  createdAt: string;
  updatedAt: string;
}
```

阅读层级：

```text
Level 1: Quick Scan
  摘要、主要贡献、难度、前置知识、是否继续

Level 2: Guided Read
  核心方法、关键图表、实验、苏格拉底式问题、是否深入

Level 3: Deep Dive
  推导、假设、实现、局限、复现、对比、是否编译
```

### 9.4 Research Profile

```ts
interface ResearchProfile {
  version: string;
  explicit: {
    topics: WeightedTerm[];
    methods: WeightedTerm[];
    followedAuthors: string[];
    excludedTopics: string[];
    preferredLanguages: string[];
    expertiseByTopic: WeightedTerm[];
  };
  learned: {
    topics: WeightedTerm[];
    methods: WeightedTerm[];
    recentFocus: WeightedTerm[];
    strongAreas: WeightedTerm[];
    weakAreas: WeightedTerm[];
    questionTopics: WeightedTerm[];
    confidence: number;
    sampleCount: number;
  };
}
```

明确偏好优先于推断偏好。隐式行为只能调整相关性和阅读优先级，不能修改科学质量分。

已读论文的语义中心可以使用现有 MiniLM 生成，但向量是可重建缓存；权威 Profile 保存论文 ID、模型配置和文本特征，不把不可解释向量作为唯一状态。

### 9.5 Adapter Contract

```ts
interface LiteratureAdapter {
  readonly name: string;
  import(input: AdapterInput): Promise<AdapterResult>;
}

interface AdapterResult {
  records: LiteratureMetadata[];
  notes?: Array<{
    canonicalKey: string;
    content: string;
  }>;
  warnings: string[];
}
```

适配器输出必须进入同一规范化、去重和来源审计流程。

## 10. 追踪流程

```text
获取 Reader 运行锁
→ 刷新已有论文版本、撤稿和 supersession
→ 执行启用的订阅
→ 多 Provider 搜索
→ 规范化和跨订阅去重
→ 排除已处理版本
→ 本地规则与语义预筛
→ 有界 Fast Triage
→ 创建或更新 Passport
→ 可选 OA 全文获取
→ 可选 Standard Review
→ 生成日报
→ 保存运行记录和成本
→ 释放锁
```

规则：

1. 默认只保存候选元数据，不自动下载或编译全部候选。
2. 全文获取必须满足 OA、安全检查、下载预算和审批。
3. Metadata-only 不能产生完整质量 Review。
4. 所有被过滤候选保留最小审计信息。
5. 重复运行必须幂等。
6. arXiv 继续使用全局最小请求间隔。
7. Provider 失败时尝试允许的替代 Provider，并明确记录降级状态。

## 11. Triage 设计

### 11.1 确定性预筛

输入：

- 标题和摘要。
- 查询来源。
- 用户明确研究兴趣。
- 现有论文和 Wiki 主题。
- 已读论文语义中心。
- 作者订阅。
- 语言偏好。
- 已有论文引用和被引用关系（数据可用时）。
- 日期和版本。

输出：

- 语义相关性。
- 关键词相关性。
- 作者订阅匹配。
- 已知论文重复或版本更新。
- 是否进入 LLM Fast Triage。

### 11.2 Fast Triage

Fast Triage 只判断：

- 研究方向相关性。
- 作者声称的主要贡献。
- 是否值得获取全文。
- 可能的前置知识。
- 摘要层面可观察的风险。

禁止判断：

- 实验是否充分。
- 证明是否正确。
- 可复现性是否良好。
- 论文最终科学质量。

### 11.3 推荐策略

推荐由确定性策略根据多个独立信号生成：

```text
Personal Relevance
+ Fast Triage Confidence
+ Knowledge Gap Value
+ Recency
+ User Constraints
→ Reading Priority
```

新论文引用数低不能自动降级；作者或机构不能自动升级。

## 12. Reviewer 设计

### 12.1 Fast Review

输入：标题和摘要。

输出：

- 研究问题。
- 声称贡献。
- 相关性。
- 获取全文建议。
- 输入覆盖说明。

所有无法验证的质量维度为 `unknown`。

### 12.2 Standard Review

必须先获取全文，并按章节提取：

```text
摘要
引言
相关工作
方法
理论
实验
消融
局限
参考文献
```

一个维度只有在以下条件同时满足时才能评分：

```text
存在对应内容
+ 存在精确引文
+ 引文通过确定性验证
```

### 12.3 Deep Review

增加：

- 隐含假设。
- 设计选择和替代方案。
- 实验公平性。
- 混淆因素。
- 缺失消融。
- 结论是否超出证据。
- Cherry-picking 风险。
- 与已有 Wiki Claim 的支持、限定和矛盾关系。
- 复现路径、资源和潜在故障。
- 对用户项目的可迁移技术点。

### 12.4 Paper Type

先分类论文类型，再应用类型特定维度：

- Empirical：实验、方法和复现权重较高。
- Theoretical：理论、假设和证明权重较高。
- Survey：完整性、组织和洞察权重较高。
- Systems：实验、复现、资源和部署权重较高。
- Reproduction：实验和复现权重较高，创新权重较低。
- Short/Workshop：降低完整实验预期，但不降低证据诚实要求。

用户可以覆盖类型，覆盖记录在 Review 历史中。

### 12.5 Devil's Advocate

```text
Initial Review
→ Adversarial Challenge
→ 每个挑战评分和证据检查
→ Synthesis
→ 已解决和未解决挑战分别保存
```

用户反对不会触发无条件改分。Re-review 必须记录：

- 旧分数。
- 新分数。
- 变化原因。
- 新证据。
- 是否仅因用户偏好变化。

### 12.6 引用完整性

分两层实现：

1. Review 自身引用论文原文的精确引文验证。
2. 论文参考文献的多 Provider 身份验证。

参考文献状态：

```text
verified
unresolvable
suspicious
retracted
```

数据库未收录不等于伪造，不允许仅因单个 Provider 查不到就判定引用虚假。

Claim-faithfulness 审计只有在取得被引来源全文时才执行。

预印本发布时间可以作为来源上下文，但“发表于生成式 AI 普及之后”本身不是污染或伪造证据，不进入拒绝门禁。

完整性问题分级：

```text
blocking
  明确伪造引用、撤稿未披露、Review 引文无法验证

high-warning
  Claim 与引用不符、时间逻辑冲突、关键实验信息缺失

medium-warning
  Provider 或审计工具失败、部分引用无法解析

advisory
  写作、组织和非关键复现信息问题
```

### 12.7 时间完整性

Reviewer 检查：

- 论文时间早于被引用工作。
- 对未来方法或数据的时代错置比较。
- 因果时间倒置。
- 使用旧文献中的“当前”“最近”却被当作现在事实。
- 新版本覆盖旧版本后 Review 是否过期。

### 12.8 Cross-model Validation

只对以下情况启用：

- 高影响接受/拒绝建议。
- 多次 Review 分歧较大。
- 引用完整性高风险。
- 用户显式请求。

结果必须保留各模型独立输出和综合过程。

## 13. 渐进式阅读

### 13.1 Quick Scan

- 3 分钟级摘要卡片。
- 问题、贡献、主要方法。
- 难度。
- 前置知识。
- 推荐阅读章节。
- 用户决定继续、稍后或归档。

### 13.2 Guided Read

- 苏格拉底式提问。
- 核心定义、公式和图表导航。
- 逐节问答。
- 检查用户是探索模式还是目标模式。
- 不在用户仍探索时强制总结或收敛。

### 13.3 Deep Dive

- 方法推导。
- 实现细节。
- 实验和局限。
- 复现清单。
- 与已有论文的对比。
- 用户理解自评和未解决问题。

### 13.4 Compare

输入两篇或多篇论文，生成：

- 问题定义差异。
- 方法设计差异。
- 实验条件对齐情况。
- 优缺点。
- 适用边界。
- 支持、限定和矛盾 Claim。

任何数值对比必须确认实验设置可比。

### 13.5 Extract

提取并编译：

- 方法。
- 数据集。
- 指标。
- Baseline。
- 参数。
- 核心 Claim。
- 前置概念。
- 论文关系。

输出到现有 Wiki，并保留用户内容。

## 14. 注释、笔记和问答

### 14.1 自动高亮

后期 UI 支持：

- 关键定义。
- 核心公式。
- 主要结论。
- 实验结果。
- 局限性。
- 与 Review 证据对应的原文。

### 14.2 AI 注释

- 术语解释。
- 背景补充。
- 与 Wiki 概念的链接。
- 公式直觉。
- 前置知识提示。

注释必须区分：

- 论文原文。
- AI 解释。
- 用户笔记。
- Wiki 外部证据。

### 14.3 用户笔记

阶段顺序：

1. Markdown 文本。
2. PDF 选区批注。
3. 手写输入。
4. 语音转写。

用户笔记永不被生成内容覆盖。

### 14.4 Paper-scoped Q&A

只检索当前论文，答案引用页码、章节或引文。

### 14.5 Corpus-scoped Q&A

复用现有 Claim Registry 和语义检索，并明确区分当前论文证据和跨论文证据。

## 15. 知识图谱、导航和综述

### 15.1 关系

- 引用关系。
- 方法演进。
- 支持、限定、重复和矛盾。
- 数据集和指标复用。
- 前置知识依赖。
- 论文到用户项目的应用关系。

### 15.2 导航

- 某主题必读论文。
- 推荐阅读顺序。
- 前置概念树。
- 方法发展时间线。
- 最新版本和近期工作。
- 未解决知识缺口。

### 15.3 可视化

后期 UI：

- 论文引用网络。
- 概念关系图。
- 方法演进图。
- 时间线。
- 阅读进度和知识缺口图。

继续以现有 JSON Claim Graph 为权威数据，不要求 Neo4j。

### 15.4 综述工作流

支持：

```text
用户研究问题
→ 已读语料分析
→ 子主题识别
→ 覆盖与缺口分析
→ 推荐补充文献
→ 证据矩阵
→ 综述大纲
```

系统生成的是带来源的研究计划和大纲，不自动把未核验内容写成最终论文。

## 16. 阅读质量与推理模式

### 16.1 阅读分析

可记录：

- Quick Scan、Guided Read 和 Deep Dive 次数。
- 阅读完成率。
- 用户理解自评。
- 未解决问题。
- 一段时间后的可选留存检查。
- 重复出现的薄弱概念。

“知识留存率”只有在用户完成明确测试时才计算，不能根据停留时间猜测。

### 16.2 Dialogue Health

长阅读会话定期检查：

- 是否持续无条件同意。
- 是否回避冲突。
- 是否过早收敛。
- 是否遗漏用户仍在探索的分支。

触发后注入挑战问题或暂停总结。

### 16.3 推理模式库

模式以版本化 Markdown 保存，例如：

- 方法评估。
- 实验严谨性。
- 理论假设。
- 可复现性。
- 对比阅读。
- 综述覆盖。
- 引用完整性。

模式是检查框架，不是未经验证的结论。

### 16.4 Reset Boundary

每个阅读层级确认点保存 Reading Session 快照。新会话可以从 Passport 和 Session 恢复，避免依赖长对话记忆。

## 17. 个性化和校准

### 17.1 反馈

- Priority、Deep Read、Skim、Dismiss。
- 开始阅读。
- 完成阅读。
- 中途放弃。
- 用户质量评分。
- 用户个人价值评分。
- 用户对 AI 推荐的明确评价。
- 用户对某个 Review 维度的反驳及证据。
- 用户问题涉及的主题和概念，作为低权重兴趣信号。

显式反馈权重大于点击和停留时间。

### 17.2 Profile 更新

- 用户明确配置永远优先。
- 学习结果具有最大变化幅度。
- 样本不足时显示 `uncalibrated`。
- 每次更新记录输入事件、旧值、新值和算法版本。
- 不推断或保存与研究推荐无关的敏感个人属性。

### 17.3 两套校准

1. Reviewer 客观校准：使用 gold set。
2. 用户偏好校准：使用用户反馈。

用户偏好只能影响 Personal Relevance 和 Reading Priority，不能改写 Scientific Quality。

## 18. 报告

### 18.1 日报

- 各 Provider 获取数量。
- 去重和版本更新数量。
- Priority、Deep Read、Skim、Archive。
- 每篇推荐原因。
- 预计阅读时间。
- 前置知识。
- 与已读论文的关系。
- Review 覆盖率和置信度。
- Metadata-only 警告。
- Token、下载和失败统计。
- 待批准事项。

### 18.2 周报

- 阅读和完成情况。
- 新增方法、数据集、指标和 Claim。
- 主题频率变化。
- 新出现的支持和矛盾关系。
- 用户明确反馈。
- 推荐校准变化。
- 强项、薄弱领域和未解决问题。
- 下周建议阅读列表。

### 18.3 趋势报告

趋势首先由结构化统计得到。LLM 叙述必须引用 Paper ID，不允许生成无来源趋势。

## 19. CLI

```bash
research-reader --root <wiki> init

research-reader subscription-add
research-reader subscription-list
research-reader subscription-enable <id>
research-reader subscription-disable <id>
research-reader subscription-remove <id>

research-reader import <file-or-directory>
research-reader adapter-run <adapter> <input>

research-reader track --dry-run
research-reader track --approve-network
research-reader track --approve-network --approve-llm

research-reader papers --status queued
research-reader paper-show <paper-id>
research-reader paper-acquire <paper-id> --approve-network
research-reader paper-review <paper-id> --level standard --approve-llm
research-reader paper-compare <paper-id> <paper-id> --approve-llm
research-reader paper-mark <paper-id> --status reading
research-reader paper-rate <paper-id> --quality 8 --value 9

research-reader read-start <paper-id> --mode guided-read
research-reader read-resume <session-id>
research-reader read-checkpoint <session-id>
research-reader read-complete <session-id>

research-reader note-add <paper-id>
research-reader extract <paper-id> --approve-llm

research-reader report-daily
research-reader report-weekly
research-reader review-survey-plan

research-reader profile-show
research-reader profile-update
research-reader profile-rebuild

research-reader calibration-create
research-reader calibration-run --approve-llm
research-reader calibration-status

research-reader daemon \
  --approve-network \
  --interval 86400 \
  --max-duration 604800

research-reader runs
research-reader history
research-reader health
research-reader approvals
research-reader approval-approve <id>
research-reader approval-reject <id>
```

## 20. 配置

新增 `.research-reader-config.json`：

```json
{
  "version": 1,
  "tracking": {
    "enabled": false,
    "lookbackDays": 2,
    "maxCandidatesPerRun": 100,
    "maxLlmCandidatesPerRun": 20,
    "maxFullTextDownloadsPerRun": 3,
    "concurrency": 3,
    "preferredLanguages": ["en"]
  },
  "triage": {
    "semanticWeight": 0.6,
    "keywordWeight": 0.25,
    "authorWeight": 0.15,
    "minimumRelevance": 0.3
  },
  "review": {
    "autoFastReview": false,
    "autoStandardReview": false,
    "requireFullTextForStandard": true,
    "adversarialPass": true,
    "citationIntegrity": true,
    "temporalIntegrity": true,
    "maxTokensPerRun": 100000
  },
  "reading": {
    "requireLevelConfirmation": true,
    "autoCompileOnComplete": false,
    "retentionChecksEnabled": false
  },
  "profile": {
    "learningEnabled": false,
    "minimumExplicitFeedback": 20,
    "maximumLearnedWeightChange": 0.1
  },
  "scheduler": {
    "enabled": false,
    "cron": null,
    "timezone": "local",
    "intervalSeconds": 86400,
    "jitterSeconds": 900,
    "staleLockSeconds": 1800
  }
}
```

模型名、价格和延迟不硬编码。默认继承 Wiki 模型，可为 fast、standard、deep 和 cross-validation 配置不同模型。

密钥仅来自环境变量。

## 21. 调度、审批和恢复

- Scheduler 使用独占 Reader 锁。
- 每轮生成 Run Record 和 JSONL 事件。
- 网络、LLM、全文、通知和知识编译使用不同审批类型。
- 可恢复已下载但未 Review、已 Review 但未生成报告的中断状态。
- 无权限或预算不足时进入 `waiting_approval`，不伪装成功。
- API 故障时记录 Provider、错误类型、重试次数和降级结果。

## 22. Web 阅读器安全

- 仅监听 `127.0.0.1`。
- 路径严格限制在 Wiki root 和允许的 raw/cache 目录。
- 不提供任意文件读取 API。
- 修改操作要求本地 CSRF token。
- PDF 和附件返回正确 MIME。
- 外部链接不自动访问。
- Web UI 关闭时不影响 CLI 和后台运行。

## 23. 监控、性能和部署

### 23.1 运行指标

- 候选、去重、版本更新和导入数量。
- 各 Provider 请求数、延迟、错误和限流。
- Fast/Standard/Deep Review 数量。
- 各阶段 p50、p95 延迟。
- LLM 输入、输出和 thinking Token。
- 下载数量和字节。
- Cache 命中率。
- 用户覆盖率、完成率和显式满意度。
- Calibration FNR、FPR、MAE 和分歧率。
- Evidence Anchor 验证失败率。

性能目标必须在本机 benchmark 后建立，不能直接沿用原始文档中的 2 秒、10 秒或 60 秒估算。

### 23.2 成本

- 价格由配置提供，不硬编码模型价格。
- 每次 Run 保存模型、Token 和计算成本快照。
- 报告显示预算上限、实际使用和被预算阻止的工作。
- 批处理只能优化调度，不能牺牲每篇论文的证据隔离。

### 23.3 部署

首选部署：

```text
本地 CLI
→ 本地 daemon
→ 本地 Web UI
```

可选提供 Docker 镜像，但 Docker 不得成为 CLI、测试或本地阅读的强制依赖。容器部署继续使用只读根文件系统、资源限制、非 root 用户和显式挂载的 Wiki 目录。

## 24. 测试

### 24.1 单元测试

- DOI/arXiv/OpenAlex 身份归一化。
- Paper Passport 状态转换。
- arXiv 版本更新。
- Review 覆盖判断。
- Evidence Anchor 验证。
- Paper Type 权重。
- Reading Session 检查点。
- Profile 有界更新。
- Report 确定性输出。
- Adapter schema。
- 配置验证和迁移。

### 24.2 集成测试

- 多 Provider 候选合并。
- 同一论文多订阅去重。
- Metadata-only 不产生虚假维度评分。
- 全文获取后生成证据化 Review。
- Citation 和 Temporal Integrity。
- Token、候选和下载预算。
- 并发锁和过期锁恢复。
- 中断恢复。
- LLM 响应损坏时不写入半成品。
- 重复运行幂等。
- 用户 Markdown 内容保留。

### 24.3 E2E

```text
初始化
→ 添加离线订阅
→ 获取 fixture 候选
→ Fast Triage
→ 获取测试 PDF
→ Standard Review
→ Guided Reading Session
→ 用户笔记
→ Extract 到 Wiki
→ 生成日报
→ 记录反馈
→ 更新 Profile
```

### 24.4 Benchmark

- Triage 使用用户标注候选集评估 Recall@K 和误过滤。
- Reviewer 使用公开或可合法分发的 gold set。
- 引用有效性目标为 100%。
- 未覆盖维度误评分目标为 0。
- 未建立足够 benchmark 前系统显示 `uncalibrated`。
- Cross-model 结果单独报告，不与主模型结果混合。

### 24.5 强制验收门禁

- 现有 build、typecheck、lint 和测试全部通过。
- 新测试不执行真实网络和付费调用。
- Reader 禁用时现有输出不变。
- 重复 Tracking 不产生重复论文。
- 同一 Reader 任务只能有一个进程持锁。
- Token、下载、候选和并发不越界。
- 所有 Review 引文可验证。
- 无输入依据的维度返回 `unknown`。
- 新 arXiv 版本会标记旧 Review 过期。
- 用户笔记和手写内容不被覆盖。
- 未校准系统不声称达到人类专家一致率。

## 25. 实施阶段

| 阶段 | 内容 | 完成条件 |
|---|---|---|
| Phase 0 | 规格、许可边界、数据契约、验收基线 | 原始目标全部映射，clean-room 边界明确 |
| Phase 1 | Shared 通用运行时、Reader 包骨架、配置、Passport | 状态持久化、迁移、锁和 CLI 可用 |
| Phase 2 | 订阅、Tracking、去重、Triage、日报 | Metadata-only 自动追踪闭环 |
| Phase 3 | 全文、Standard/Deep Reviewer、证据和完整性门禁 | 证据化评审闭环 |
| Phase 4 | Reading Session、Markdown 笔记、Compare、Extract | CLI 渐进式阅读闭环 |
| Phase 5 | Profile、反馈、校准、周报、趋势 | 个性化学习闭环 |
| Phase 6 | PDF Web UI、高亮、批注、Paper Q&A | 完整可视阅读器 |
| Phase 7 | 图谱导航、留存分析、推理模式、综述工作流 | 原始知识导航和自进化目标完整 |
| Phase 8 | PubMed/Zotero/Obsidian/LaTeX、会议、社区、通知、语音/手写 | 高级扩展 |

交付定义：

- Phase 1-3：Research Backend MVP。
- Phase 1-5：可用的个性化 CLI 论文阅读系统。
- Phase 1-6：完整用户可见论文阅读器 MVP。
- Phase 1-8：覆盖四份原始材料中的完整长期愿景。

## 26. PR 和集成策略

建议按以下顺序提交：

1. 规格和 schema。
2. Shared runtime。
3. Reader package 和存储。
4. Tracking/Triage/Report。
5. Reviewer。
6. Reading Session/Compare/Extract。
7. Profile/Calibration。
8. Web UI。
9. 图谱、分析和高级适配器。

每个 PR：

- 默认关闭新功能。
- 只增加向后兼容配置。
- 单独运行目标测试和全仓测试。
- 不改动 `master` 业务工作目录。
- 不在未通过门禁时合并。

所有 npm 操作使用内部 registry：

```text
https://packagefeedproxy.microsoft.io/npm/
```

## 27. 原始目标覆盖审计

### 27.1 `paper-reader-design.md`

| 原始目标 | 当前方案 | 状态 |
|---|---|---|
| PDF、HTML 导入 | 复用 Compiler ingest/full-text | 已覆盖 |
| 本地目录和批量导入 | Import CLI + Folder Adapter | 已补回 |
| LaTeX 导入 | Adapter Phase 8 | 延期 |
| PubMed | Adapter Phase 8 | 延期 |
| Google Scholar | 仅授权数据出口 | 有意限制 |
| 自动元数据 | Provider + Passport | 已覆盖 |
| 自动标签和分组 | Profile、Triage、Passport | 已覆盖 |
| 语言偏好和过滤 | Subscription/Profile | 已补回 |
| 阅读状态 | Passport | 已覆盖 |
| 3 分钟/15 分钟/深度阅读 | Reading Session 三层模式 | 已补回 |
| 自动高亮 | Web Phase 6 | 已补回 |
| AI 注释 | Web Phase 6 | 已补回 |
| Markdown 笔记 | Phase 4 | 已覆盖 |
| 手写和语音 | Phase 8 | 已补回并延期 |
| 交互问答 | Paper/Corpus Q&A | 已覆盖 |
| 方法、数据集、指标、Baseline、参数 | Extract | 已补强 |
| 引用网络和方法演进 | Graph Phase 7 | 已补回 |
| 对比关系 | Compare | 已覆盖 |
| 阅读依赖树 | Navigation Phase 7 | 已补回 |
| Wiki 编译 | Compiler + Extract | 已覆盖 |
| 图谱和时间线 | Web/Graph Phase 7 | 已补回 |
| 推荐阅读顺序 | Navigation | 已补回 |
| 阅读质量和留存 | Analytics Phase 7 | 已补回 |
| 主动推荐、矛盾、缺口 | Frontier + Profile | 已覆盖 |
| 推理模式库 | Patterns Phase 7 | 已补回 |
| 综述准备 | Survey Workflow | 已补回 |
| 本地和 Docker 部署 | Local-first + optional Docker | 已补回 |

### 27.2 `paper-reader-with-arxiv-tracking.md`

| 原始目标 | 当前方案 | 状态 |
|---|---|---|
| arXiv 每日追踪 | Subscription + Scheduler | 已覆盖 |
| 查询权重和标签 | Subscription schema | 已覆盖 |
| 固定时间运行 | Cron、timezone、jitter | 已补回 |
| 增量和去重 | Identity + Passport | 已覆盖 |
| 两阶段筛选 | Deterministic Triage + Fast Review | 已覆盖并修正 |
| Priority/Deep/Skim/Archive | Passport recommendation | 已覆盖 |
| 每日报告 | Reports | 已覆盖 |
| 周报和趋势 | Reports Phase 5 | 已覆盖 |
| Research Profile | Profile | 已覆盖 |
| 已读论文语义表示 | Rebuildable MiniLM profile cache | 已补回 |
| 强项、弱项、近期关注 | Profile learned fields | 已补回 |
| 作者追踪 | Subscription | 已覆盖 |
| 会议追踪 | Phase 8 | 延期 |
| 社区信号 | Phase 8，不进入科学质量 | 有意调整 |
| 对比阅读 | Compare | 已覆盖 |
| 预计阅读时间 | Review | 已补回 |
| 邮件、Slack、桌面通知 | 后期独立审批 | 延期 |
| 成本控制 | Token/download/run budget | 已覆盖 |

原文把摘要或前四页称为“深度评估”。本方案将其修正为 Fast/Partial Review；真正 Standard/Deep Review 要求相应章节或全文。

### 27.3 `ai-reviewer-system-design.md`

| 原始目标 | 当前方案 | 状态 |
|---|---|---|
| Fast/Standard/Deep | Reviewer 三层 | 已覆盖 |
| 六个核心维度 | DimensionAssessment | 已覆盖 |
| 可解释理由 | Evidence-backed rationale | 已加强 |
| 个性化 | Profile + Personal Relevance | 已覆盖 |
| 自我校准 | Calibration | 已覆盖 |
| 领域和论文类型适配 | Paper Type | 已覆盖 |
| Survey/Short/Theory/Reproduction | Type-specific review | 已覆盖 |
| 多 AI 验证 | 风险分层 Cross-model | 已调整 |
| Gold set | Benchmark | 已覆盖 |
| 人机校准 | Feedback + immutable reviews | 已覆盖 |
| Reviewer 报告卡片 | CLI/Report/Web | 已覆盖 |
| 性能和成本监控 | Runs/Health/Usage | 已覆盖 |
| p50/p95 和准确性指标 | Monitoring/Calibration metrics | 已补回 |
| Docker 部署 | Optional Docker | 已补回 |
| 多模态图表和公式 | Phase 8 | 延期 |
| 趋势和影响预测 | 仅证据化趋势；不承诺引用预测 | 有意限制 |

关键修正：

- 前三页不能用于完整实验和复现评分。
- `accept/reject` 不适合作为个人阅读队列的唯一标签。
- 科学质量和个人相关性必须分离。
- 不使用作者团队影响力作为科学质量依据。
- 不用不同 temperature 模拟独立 Reviewer。

### 27.4 `learnings-from-academic-research-skills.md`

| 原始建议 | 当前方案 | 状态 |
|---|---|---|
| Human-in-the-Loop | 审批和阅读检查点 | 已覆盖 |
| Mandatory Integrity Gates | Citation/Temporal/Evidence gates | 已覆盖 |
| Material Passport | Paper Passport + Reading Session | 已覆盖 |
| Devil's Advocate | Adversarial Pass | 已覆盖 |
| Anti-Sycophancy | Immutable review + change audit | 已覆盖 |
| Intent Detection | Reading Session intent | 已补回 |
| Dialogue Health | Session health checks | 已补回 |
| 多源引用验证 | Provider verification | 已覆盖 |
| 三层锚点 | Quote/page/section anchor | 已覆盖 |
| 未索引不等于伪造 | 引用状态模型 | 已覆盖 |
| 预印本污染信号 | 仅保留上下文，不作为伪造证据 | 有意修正 |
| 时间完整性 | Temporal Integrity | 已补回 |
| Reviewer Calibration | Benchmark/Calibration | 已覆盖 |
| 风险分层跨模型 | Cross-model policy | 已覆盖 |
| 语言中立适配器 | Adapter Contract | 已补回 |
| 多模式交互 | Reading modes | 已补回 |
| Reset Boundary | Session checkpoints | 已补回 |
| 模型分层 | 可配置 model profiles | 已覆盖 |
| Graceful Degradation | Provider fallback and explicit status | 已补回 |
| 失败模式检查 | Reviewer/Integrity gates | 已覆盖 |
| Iron Rules/Anti-patterns | 内部规则和测试门禁 | 已适配 |

实现不得复制该项目的提示词、规则文本或代码。只能基于独立设计的数据契约、测试和一般工程原则实现。

## 28. 对上一版方案的纠偏

对照四份原始材料后，上一版方案存在以下遗漏，本文已补齐：

1. Reviewer 层级与用户阅读层级被混在一起。
2. 缺少 Quick Scan、Guided Read、Deep Dive 的 Reading Session。
3. 缺少自动高亮和 AI 页内注释。
4. 缺少手写、语音笔记的长期目标。
5. 缺少方法、数据集、指标、Baseline、参数的结构化提取目标。
6. 缺少引用网络、方法演进、时间线和阅读依赖树。
7. 缺少知识留存检查和薄弱领域分析。
8. 缺少推理模式库。
9. 缺少综述准备工作流。
10. 缺少 Intent Detection 和 Dialogue Health。
11. 缺少语言中立 Adapter Contract。
12. 缺少论文参考文献验证和时间完整性检查。
13. 缺少 Provider 故障时的显式降级策略。
14. Research Profile 缺少强项、弱项和近期关注。
15. Review 缺少预计阅读时间。
16. 缺少本地目录批量导入。
17. 缺少语言偏好和过滤。
18. 缺少固定日历时间、时区和 jitter 调度。
19. 缺少已读论文语义中心的可重建缓存定义。
20. 缺少 p50/p95、FNR、FPR、MAE 等监控指标。
21. 缺少可选 Docker 部署边界。
22. 未明确纠正“新预印本时间等于污染风险”的不可靠假设。

以下变化属于有意的架构适配，不是遗漏：

1. 使用 TypeScript 而不是 Python。
2. 使用 JSON/JSONL/Markdown 而不是首期引入 SQLite。
3. 使用现有 Claim Graph 而不是 Neo4j。
4. 使用现有 MiniLM 索引而不是 ChromaDB。
5. 使用结构化独立 Pass，而不是固定创建大量 Agent 进程。
6. Google Scholar 仅允许官方或授权接入。
7. 社区热度只影响可选发现排序，不影响科学质量。
8. 作者和机构不作为质量分依据。
9. 没有全文时不提供完整质量评分。
10. 未经过真实 benchmark 前不承诺“与专家一致率超过 80%”。

## 29. 审计结论

补充上述内容后，四份原始材料中的核心产品目标均已有明确归属：

- 已有能力直接复用。
- 新能力进入明确实施阶段。
- 高风险或长期能力明确延期。
- 法律、证据或方法上不合理的部分被显式限制。

不存在静默删除的核心目标。所有未在首期实现的内容都已记录为延期或有意排除，并给出理由。
