# 论文阅读器系统方案（含arXiv自动追踪版）

## 概述

在基础论文阅读器的基础上，增加**自动文献追踪**和**智能筛选**功能，实现：
- 每日从arXiv自动获取相关领域最新论文
- 基于相关性和质量的两级筛选（略读 vs 精读）
- AI Reviewer系统评估论文质量
- 自动生成每日文献摘要报告

## 一、新增核心模块

### 1. arXiv追踪引擎（Tracker）

#### 配置文件：`tracking_config.yaml`
```yaml
research_interests:
  primary:
    - query: "cat:cs.AI AND (transformers OR attention mechanism)"
      weight: 1.0
      tags: ["deep-learning", "transformer"]

    - query: "cat:cs.LG AND (reinforcement learning OR RL)"
      weight: 0.9
      tags: ["reinforcement-learning"]

  secondary:
    - query: "cat:cs.CL AND interpretability"
      weight: 0.6
      tags: ["NLP", "explainability"]

schedule:
  frequency: "daily"  # 每天
  time: "09:00"       # 早上9点
  lookback_days: 1    # 获取过去1天的论文

filters:
  min_relevance_score: 0.3   # 最低相关性阈值
  max_daily_papers: 50       # 每天最多处理50篇
```

#### 工作流程
```
[09:00 定时触发]
    ↓
[查询arXiv API]
├─ primary queries → 获取核心领域论文
└─ secondary queries → 获取相关领域论文
    ↓
[初步过滤]
├─ 去重（已在库中的跳过）
├─ 语言过滤（仅英文）
└─ 格式验证（有完整元数据）
    ↓
输出：raw/arxiv_candidates/2026-07-17.json
```

### 2. 智能筛选系统（Triage Agent）

#### 两阶段筛选

**阶段1：相关性评分（快速）**
```python
def calculate_relevance(paper, research_profile):
    """
    基于向量相似度 + 关键词匹配
    输入：论文标题+摘要，用户研究档案
    输出：0-1的相关性分数
    """
    scores = {
        'semantic_similarity': cosine_sim(
            embed(paper.abstract),
            embed(profile.interest_summary)
        ),
        'keyword_match': keyword_overlap(
            paper.keywords,
            profile.tracked_keywords
        ),
        'author_relevance': is_known_author(
            paper.authors,
            profile.followed_authors
        ),
        'citation_network': cited_by_known_papers(
            paper.references,
            profile.read_papers
        )
    }
    return weighted_average(scores)
```

**阶段2：质量评估（AI Reviewer）**

仅对相关性 > 0.5 的论文执行：

```markdown
# AI Reviewer Prompt Template

你是一位经验丰富的学术审稿人。请评估以下论文：

**标题**：{title}
**作者**：{authors}
**摘要**：{abstract}
**引言**：{introduction_first_2_pages}

## 评估维度（每项0-10分）

1. **问题重要性**
   - 解决的问题是否有意义？
   - 是否是领域内的关键挑战？

2. **技术创新性**
   - 方法是否新颖？
   - 与现有工作的区别在哪？

3. **实验充分性**
   - 实验设计是否合理？
   - 结果是否有说服力？

4. **写作质量**
   - 论文结构是否清晰？
   - 表达是否准确？

5. **可复现性**
   - 是否提供代码/数据？
   - 方法描述是否充分？

## 输出格式
```json
{
  "scores": {
    "importance": 8,
    "novelty": 7,
    "experiments": 6,
    "writing": 8,
    "reproducibility": 9
  },
  "overall_score": 7.6,
  "verdict": "accept_major_revision",
  "strengths": ["明确的问题定义", "详细的实验", "开源代码"],
  "weaknesses": ["缺少与方法B的对比", "消融实验不足"],
  "recommendation": "deep_read",  // deep_read | skim | skip
  "estimated_read_time": 45,      // 分钟
  "prerequisite_concepts": ["attention", "meta-learning"]
}
```
```

#### 筛选决策树
```
相关性 < 0.3 → skip（直接忽略）
相关性 0.3-0.5 → 存档但不推送
相关性 0.5-0.7 + 质量 < 6 → skim（略读队列）
相关性 0.5-0.7 + 质量 ≥ 6 → deep_read
相关性 > 0.7 + 质量 ≥ 7 → priority（优先精读）
相关性 > 0.7 + 质量 < 6 → skim（可能有关键insight但写作不佳）
```

### 3. 每日文献报告生成器

#### 报告结构：`reports/daily/2026-07-17.md`
```markdown
# 每日文献摘要 - 2026年7月17日

## 📊 统计
- 获取论文：42篇
- 相关论文：18篇
- 推荐精读：5篇
- 推荐略读：8篇
- 已跳过：19篇

## 🔥 优先精读（5篇）

### 1. [9.2分] Hierarchical Attention for Long-Context Understanding
**作者**：Zhang et al. (Stanford)
**arXiv**：2407.12345
**标签**：`transformer` `efficiency` `长文本`

**为什么值得读**：
- 提出了分层注意力机制，将O(n²)降到O(n log n)
- 在长文档任务上超越Transformer-XL 5个点
- 开源代码，复现容易

**AI Reviewer评分**：
- 创新性：9/10（新的注意力分解方式）
- 实验性：8/10（4个数据集充分验证）
- 可复现：10/10（提供完整代码和配置）

**预计阅读时间**：60分钟
**前置知识**：需要先理解 [[Transformer]] 和 [[分治算法]]

**关联已读论文**：
- 引用了你读过的 "Attention Is All You Need"
- 改进了 "Longformer" 的方法

---

### 2. [8.5分] Meta-Learning for Few-Shot RL
...

## 📚 略读推荐（8篇）

### 1. [6.8分] Survey: Recent Advances in Vision Transformers
**快速摘要**：综述了2023-2026年ViT的进展，可作为参考资料，不需要深读。
**建议**：扫一遍图表和结论，记住关键论文列表即可。

---

## 📌 存档但未推荐（5篇）
这些论文相关性一般或质量不高，但可能在某些场景下有用：
- "Empirical Study of X" (实验性论文，insights有限)
- "Improved Baseline for Y" (增量改进，无新方法)
...

## 🔍 本周趋势分析
- **热点话题**：Efficient Transformers（本周出现3篇相关论文）
- **新兴方向**：神经架构搜索用于注意力设计
- **你可能感兴趣**：有2篇论文讨论了你正在研究的[[多模态学习]]

## 💡 推荐行动
1. 优先阅读 #1 "Hierarchical Attention"，与你当前研究高度相关
2. 考虑将 #2 的meta-learning方法应用到你的项目
3. 检测到知识缺口：[[课程学习]]在3篇论文中被提及，但你wiki中无相关页面
```

### 4. 个性化研究档案（Research Profile）

系统自动从你的阅读历史中学习：

```json
// meta/research_profile.json
{
  "interest_summary": "专注于Transformer架构改进，特别是效率优化...",
  "tracked_keywords": [
    {"keyword": "transformer", "weight": 1.0},
    {"keyword": "attention", "weight": 0.9},
    {"keyword": "efficiency", "weight": 0.8}
  ],
  "followed_authors": [
    "Ashish Vaswani", "Ilya Sutskever"
  ],
  "read_papers_embeddings": [...],  // 已读论文的向量表示
  "strong_areas": ["深度学习架构", "NLP"],
  "weak_areas": ["理论证明", "优化算法"],
  "recent_focus": ["长上下文建模", "高效注意力"],
  "last_updated": "2026-07-17"
}
```

这个档案每周自动更新，基于：
- 你标记为"精读"的论文
- 你在wiki中创建的页面
- 你问过的问题类型

## 二、系统架构更新

```
┌─────────────────────────────────────────────────┐
│              自动追踪层（新增）                   │
│  ┌──────────────┐  ┌─────────────────┐         │
│  │ arXiv Crawler│→│ Triage Agent     │         │
│  │ (定时任务)    │  │ - 相关性评分     │         │
│  │              │  │ - AI Reviewer    │         │
│  └──────────────┘  │ - 筛选决策       │         │
│                    └─────────────────┘         │
│                           ↓                     │
│                  ┌─────────────────┐           │
│                  │ Report Generator │           │
│                  │ 生成每日摘要      │           │
│                  └─────────────────┘           │
└─────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────┐
│              用户界面层                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │每日报告   │  │ 阅读器UI  │  │ 知识图谱  │      │
│  │仪表板     │  │          │  │          │      │
│  └──────────┘  └──────────┘  └──────────┘      │
└─────────────────────────────────────────────────┘
                      ↓
            [原有的智能体编排层]
                      ↓
            [原有的知识存储层]
```

## 三、数据流示例

### 完整的一天流程

```
[09:00] arXiv Crawler 启动
    ↓
获取42篇新论文 → 保存到 raw/arxiv_candidates/2026-07-17.json
    ↓
[09:05] Triage Agent 开始处理
    ↓
并行处理42篇：
├─ 论文1: 相关性0.85, 质量8.5 → priority
├─ 论文2: 相关性0.65, 质量7.0 → deep_read
├─ 论文3: 相关性0.55, 质量6.0 → skim
├─ 论文4: 相关性0.25 → skip
└─ ...
    ↓
[09:30] 筛选完成，分类结果：
├─ queue/priority/     (5篇)
├─ queue/deep_read/    (0篇，都被归入priority了)
├─ queue/skim/         (8篇)
└─ archive/low_relevance/ (29篇)
    ↓
[09:35] Report Generator
    ↓
生成 reports/daily/2026-07-17.md
    ↓
[09:40] 通知用户
├─ 桌面通知："今日有5篇优先论文待读"
├─ 邮件摘要（可选）
└─ Slack消息（可选）
    ↓
[10:00] 你打开每日报告
    ↓
点击第一篇论文 → 自动下载PDF → 进入阅读器
    ↓
阅读过程中：
├─ 提问 → Reading Agent回答
├─ 做笔记 → 自动保存
└─ 标记重点
    ↓
[11:30] 阅读完成，点击"完成精读"
    ↓
Extraction Agent自动：
├─ 更新 wiki/papers/hierarchical_attention.md
├─ 创建 wiki/methods/hierarchical_attention.md
├─ 更新 wiki/concepts/attention_mechanism.md
├─ 更新知识图谱
└─ 更新 research_profile.json（提升"分层结构"权重）
    ↓
[第二天09:00]
新的追踪会考虑你昨天的阅读，推荐更精准
```

## 四、AI Reviewer实现细节

### 轻量级快速评估（用于初筛）
```python
# 仅基于标题+摘要，使用小模型（Haiku）
def quick_review(paper):
    prompt = f"""
    标题：{paper.title}
    摘要：{paper.abstract}

    快速评分（0-10）：
    - 创新性：
    - 重要性：
    - 可能的影响力：

    一句话总结优缺点。
    """
    response = claude.complete(prompt, model="haiku")
    return parse_quick_score(response)
```

### 深度评估（用于高相关性论文）
```python
# 下载PDF，提取前4页，使用大模型（Opus）
def deep_review(paper):
    pdf_text = extract_first_pages(paper.pdf_url, pages=4)

    prompt = f"""
    作为资深审稿人，详细评估这篇论文...

    {pdf_text}

    [使用前面的详细评分模板]
    """
    response = claude.complete(prompt, model="opus")
    return parse_detailed_review(response)
```

### 评分校准机制
```python
# 基于你的历史评分来校准AI的标准
def calibrate_reviewer(user_ratings, ai_ratings):
    """
    用户对论文打分后，调整AI的评分权重
    使AI的偏好逐渐与用户一致
    """
    for paper_id in common_papers:
        user_score = user_ratings[paper_id]
        ai_score = ai_ratings[paper_id]

        # 如果AI打9分但用户只给6分，降低AI对该特征的权重
        if ai_score > user_score + 2:
            reduce_weight(ai_features[paper_id])
```

## 五、目录结构

```
research-wiki/
├── raw/
│   ├── papers/          # 手动添加的PDF
│   └── arxiv_candidates/
│       ├── 2026-07-17.json  # 每日抓取的候选论文
│       └── 2026-07-18.json
│
├── queue/               # 待处理队列
│   ├── priority/        # 优先精读（AI评分>7.5且相关性>0.7）
│   │   ├── 2407.12345.pdf
│   │   └── metadata.json
│   ├── deep_read/       # 精读
│   ├── skim/            # 略读
│   └── archive/         # 低相关性存档
│
├── reports/
│   ├── daily/
│   │   ├── 2026-07-17.md
│   │   └── 2026-07-18.md
│   ├── weekly/
│   │   └── 2026-W28.md  # 周总结
│   └── trends/
│       └── emerging_topics_2026Q3.md
│
├── wiki/
│   ├── papers/          # 已读论文的详细笔记
│   ├── methods/
│   ├── concepts/
│   └── comparisons/
│
├── meta/
│   ├── research_profile.json
│   ├── tracking_config.yaml
│   └── reviewer_calibration.json
│
└── tools/
    ├── arxiv_crawler.py
    ├── triage_agent.py
    └── report_generator.py
```

## 六、关键技术实现

### arXiv API集成
```python
import arxiv

def fetch_daily_papers(config):
    """每日从arXiv获取论文"""
    client = arxiv.Client()

    all_papers = []
    for interest in config['research_interests']['primary']:
        search = arxiv.Search(
            query=interest['query'],
            max_results=100,
            sort_by=arxiv.SortCriterion.SubmittedDate
        )

        for result in client.results(search):
            if is_recent(result.published, days=1):
                all_papers.append({
                    'id': result.entry_id.split('/')[-1],
                    'title': result.title,
                    'authors': [a.name for a in result.authors],
                    'abstract': result.summary,
                    'pdf_url': result.pdf_url,
                    'published': result.published,
                    'tags': interest['tags'],
                    'query_weight': interest['weight']
                })

    return deduplicate(all_papers)
```

### 相关性评分器
```python
from sentence_transformers import SentenceTransformer

class RelevanceScorer:
    def __init__(self, profile_path):
        self.model = SentenceTransformer('all-MiniLM-L6-v2')
        self.profile = load_profile(profile_path)

    def score(self, paper):
        # 语义相似度（40%权重）
        paper_embedding = self.model.encode(
            f"{paper['title']} {paper['abstract']}"
        )
        semantic_score = cosine_similarity(
            paper_embedding,
            self.profile['interest_embedding']
        )

        # 关键词匹配（30%权重）
        keyword_score = self._keyword_match(
            paper['abstract'],
            self.profile['keywords']
        )

        # 作者相关性（20%权重）
        author_score = self._author_relevance(
            paper['authors'],
            self.profile['followed_authors']
        )

        # 引用网络（10%权重）
        citation_score = self._citation_relevance(
            paper['id'],
            self.profile['read_papers']
        )

        return (
            0.4 * semantic_score +
            0.3 * keyword_score +
            0.2 * author_score +
            0.1 * citation_score
        )
```

### AI Reviewer集成
```python
from anthropic import Anthropic

class AIReviewer:
    def __init__(self):
        self.client = Anthropic()

    def review(self, paper, depth='quick'):
        if depth == 'quick':
            return self._quick_review(paper)
        else:
            return self._deep_review(paper)

    def _deep_review(self, paper):
        # 下载并解析PDF前几页
        pdf_text = self._extract_pdf_text(paper['pdf_url'], pages=4)

        prompt = f"""你是一位经验丰富的学术审稿人。请评估以下论文：

标题：{paper['title']}
作者：{', '.join(paper['authors'])}

摘要：
{paper['abstract']}

引言与方法（前4页）：
{pdf_text}

请从以下维度评分（0-10分）：

1. **问题重要性**：解决的问题是否有意义？
2. **技术创新性**：方法是否新颖？
3. **实验充分性**：实验设计是否合理、结果有说服力？
4. **写作质量**：结构清晰度、表达准确性
5. **可复现性**：是否提供足够细节/代码

输出JSON格式：
{{
  "scores": {{
    "importance": <分数>,
    "novelty": <分数>,
    "experiments": <分数>,
    "writing": <分数>,
    "reproducibility": <分数>
  }},
  "overall_score": <总分>,
  "strengths": [<优点列表>],
  "weaknesses": [<缺点列表>],
  "recommendation": "<deep_read|skim|skip>",
  "estimated_read_time": <分钟>,
  "prerequisite_concepts": [<前置概念>]
}}"""

        response = self.client.messages.create(
            model="claude-opus-4-8",
            max_tokens=2000,
            messages=[{"role": "user", "content": prompt}]
        )

        return json.loads(response.content[0].text)
```

### 每日报告生成器
```python
class ReportGenerator:
    def generate_daily_report(self, date, papers):
        priority = [p for p in papers if p['category'] == 'priority']
        deep_read = [p for p in papers if p['category'] == 'deep_read']
        skim = [p for p in papers if p['category'] == 'skim']

        report = f"# 每日文献摘要 - {date}\n\n"
        report += self._stats_section(papers)
        report += self._priority_section(priority)
        report += self._deep_read_section(deep_read)
        report += self._skim_section(skim)
        report += self._trends_section(papers)
        report += self._recommendations_section(papers)

        return report

    def _priority_section(self, papers):
        section = f"\n## 🔥 优先精读（{len(papers)}篇）\n\n"

        for i, paper in enumerate(papers, 1):
            review = paper['review']
            section += f"### {i}. [{review['overall_score']:.1f}分] {paper['title']}\n"
            section += f"**作者**：{', '.join(paper['authors'])}\n"
            section += f"**arXiv**：{paper['id']}\n"
            section += f"**标签**：{' '.join(f'`{t}`' for t in paper['tags'])}\n\n"

            section += "**为什么值得读**：\n"
            for strength in review['strengths']:
                section += f"- {strength}\n"

            section += f"\n**预计阅读时间**：{review['estimated_read_time']}分钟\n"

            if review['prerequisite_concepts']:
                concepts = ' 和 '.join(f"[[{c}]]" for c in review['prerequisite_concepts'])
                section += f"**前置知识**：需要先理解 {concepts}\n"

            section += "\n---\n\n"

        return section
```

## 七、用户体验流程

### 早晨工作流
```
[09:00] 你打开邮件/Slack，看到通知：
        "今日追踪到42篇论文，筛选出5篇优先推荐"
    ↓
[09:10] 打开每日报告仪表板
        看到5篇优先论文的卡片式摘要
    ↓
[09:15] 点击第一篇 "Hierarchical Attention"
        - 左侧：PDF自动加载
        - 右侧：AI生成的阅读指南
          · 3分钟摘要
          · 关键贡献
          · 与你已读论文的关联
          · 推荐重点关注的章节
    ↓
[09:20] 开始精读
        边读边问：
        你："公式3为什么这么设计？"
        AI："这个分层结构是为了降低计算复杂度..."
    ↓
[10:30] 读完，点击"完成精读"
        AI自动生成笔记草稿供你审阅
    ↓
[10:35] 审阅并编辑笔记
        保存后，wiki自动更新
    ↓
[10:40] 看第二篇优先论文
        或者标记"稍后读"，加入个人队列
    ↓
[11:00] 浏览略读列表
        快速扫一眼8篇论文的摘要卡片
        标记2篇"可能有用"，其余忽略
```

### 周末回顾
```
[周日] 打开周报：reports/weekly/2026-W28.md
    ↓
看到：
- 本周读了7篇精读论文
- 知识图谱新增23个实体、45个关系
- 你的研究兴趣向"多模态"方向偏移
- 热门话题：高效Transformer（连续3周出现）
    ↓
AI建议：
"检测到你在'对比学习'上有知识缺口，
 推荐补充阅读3篇基础论文"
    ↓
你批准 → AI自动将这3篇加入优先队列
```

## 八、进阶功能

### 1. 社区过滤器（可选）
```yaml
# 集成Twitter/Reddit学术社区的讨论热度
community_signals:
  twitter:
    enabled: true
    accounts: ["_akhaliq", "hardmaru"]  # 关注的学术账号
    min_likes: 100  # 至少100个赞才纳入考虑

  reddit:
    enabled: true
    subreddits: ["MachineLearning"]
    min_upvotes: 50
```

如果一篇论文在社区有热烈讨论，提升其优先级。

### 2. 会议追踪
```yaml
# 自动追踪顶会接收论文
conferences:
  - name: "NeurIPS"
    track_accepted: true
    priority_boost: 0.2  # 顶会论文自动提升优先级

  - name: "ICML"
    track_accepted: true
    priority_boost: 0.2
```

### 3. 作者追踪
```yaml
# 当这些作者发新论文时立即通知
followed_authors:
  - name: "Yoshua Bengio"
    notify: "immediate"

  - name: "Ilya Sutskever"
    notify: "immediate"
```

### 4. 对比阅读模式
```
当检测到两篇论文解决类似问题时：
    ↓
AI自动生成对比文档：
- 方法A vs 方法B的设计差异
- 实验结果对比表
- 各自的优缺点
- 适用场景分析
    ↓
保存为：wiki/comparisons/method_a_vs_b.md
```

## 九、实现优先级

### Phase 1: 基础追踪（1周）
- [ ] arXiv API集成
- [ ] 基于关键词的简单过滤
- [ ] 每日论文列表生成
- [ ] 手动标记"精读"vs"略读"

### Phase 2: 智能筛选（2周）
- [ ] 相关性评分算法
- [ ] AI Reviewer（快速版，仅用Haiku）
- [ ] 自动分类（priority/deep/skim）
- [ ] 每日报告生成

### Phase 3: 个性化（2周）
- [ ] 研究档案自动学习
- [ ] 评分校准机制
- [ ] 趋势分析
- [ ] 周报生成

### Phase 4: 高级功能（持续）
- [ ] 社区信号集成
- [ ] 会议追踪
- [ ] 对比阅读模式
- [ ] 移动端通知

## 十、成本估算

假设每天处理50篇论文：

```
快速筛选（50篇 × Haiku）:
- 输入：500 tokens/篇
- 输出：100 tokens/篇
- 成本：~$0.15/天

深度评估（5篇 × Opus）:
- 输入：4000 tokens/篇（含PDF前4页）
- 输出：500 tokens/篇
- 成本：~$0.50/天

总计：~$0.65/天 ≈ $20/月
```

如果预算有限，可以：
- 仅对相关性>0.8的论文做深度评估
- 使用Sonnet代替Opus（成本降至1/3）
- 批量处理降低API调用次数

## 十一、与现有工具对比

| 功能 | arXiv-sanity | Papers with Code | 本方案 |
|------|--------------|------------------|--------|
| 自动追踪 | ✅ | ✅ | ✅ |
| 质量评估 | ❌ | ❌（仅看star数） | ✅ AI Reviewer |
| 个性化推荐 | 简单 | 基于浏览历史 | 深度学习研究档案 |
| 深度阅读辅助 | ❌ | ❌ | ✅ 交互式AI助手 |
| 知识积累 | ❌ | ❌ | ✅ 自动编译到wiki |
| 趋势分析 | 基础 | ✅ | ✅ + 与个人关联 |

## 十二、关键创新点

1. **AI作为第一读者**：在你阅读之前，AI已经读过并做了预判
2. **从追踪到理解的闭环**：不只是推送列表，而是全程辅助直到知识固化
3. **质量把关**：通过AI Reviewer避免浪费时间在低质量论文上
4. **自我进化的推荐**：随着你的阅读，推荐越来越精准
5. **知识化而非信息化**：每篇论文不是孤立的PDF，而是知识图谱中的节点
