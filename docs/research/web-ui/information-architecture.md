# Web UI 调研：信息架构（Benchmarks / Agents / 迭代进化）

由 Codex（gpt-6.1-sol）读取 Orbit 源码与文档并联网查阅官方资料后写成（2026-11-06，基线 `main@5b2343e`）；第三方结论未登录产品实测。取舍见 [design.md §9.16](../../design.md)。

**建议把 Orbit 的主线明确为：发现 Benchmark → 选择 Agent / Policy → 固定方法版本 → 运行评测 → 从失败证据改进方法。** 优先提升 Benchmarks、Agents 的可见性，并提供默认带文字的侧栏；随后补齐方法版本与实验关系。

调研基于当前 `main@5b2343e` 的指定文档、代码及公开官方资料。未修改文件、未启动实验、未检查私人凭据或本机运行数据库。以下界面均为设计建议；线框中的数字为示意。

## 1. 结论：12 个最值得采用的模式

| 模式 | 来源与已核实做法 | 在 Orbit 中怎么用 |
| --- | --- | --- |
| 1. 默认展示文字，允许主动折叠 | [Linear](https://linear.app/changelog/2024-12-18-personalized-sidebar) 支持侧栏定制；[Vercel](https://vercel.com/changelog/dashboard-navigation-redesign-rollout) 使用可调整、可隐藏的侧栏 | 桌面默认“图标＋文字”；折叠状态记住个人偏好，首次使用保持展开 |
| 2. 全局导航稳定，详情提供上下文导航 | [Grafana](https://grafana.com/docs/grafana/latest/whatsnew/whats-new-in-v9-3/) 将相关工具分组，并结合侧栏和面包屑 | 全局按对象组织；Benchmark → Job → Trial → Run 保持明确的返回路径 |
| 3. 多个独立分面共同筛选 | [Hugging Face](https://huggingface.co/datasets) 分开提供 Tasks、Libraries、Modalities 等；[Inspect](https://inspect.aisi.org.uk/evals/) 提供分类、搜索和数量 | 将交互类别、领域、profiles、接入证据分别筛选；选中条件显示为可移除标签 |
| 4. 总量、类型覆盖、任务规模同时出现 | [Harbor Hub](https://hub.harborframework.com/datasets) 显示目录总量和每项任务数；[Epoch](https://epoch.ai/benchmarks/search) 提供可浏览的 Benchmark 注册表 | 首页直接显示登记数量、覆盖类别、领域；任务数标明单位，避免把套件数混入 Benchmark 数 |
| 5. 每个 Benchmark 都有身份与协议说明 | [OpenCompass](https://doc.opencompass.org.cn/user_guides/datasets.html) 区分配置、数据与评分协议；[Papers with Code 数据](https://github.com/paperswithcode/paperswithcode-data) 关联论文、代码、数据集和评测表 | 详情固定展示来源、版本、协议变体、指标、实现 adapter、限制及证据 |
| 6. Agent 目录直接展示能力 | [Harbor Agents](https://docs.harborframework.com/agents/pre-integrated-agents) 提供能力对应表；[LiteLLM AI Hub](https://docs.litellm.ai/docs/proxy/ai_hub) 让用户发现可用模型与 Agent | 新增独立 Agents 页面，展示全部注册定义、能力、安装路径、认证与运行记录 |
| 7. Harness 与 Model 分开呈现 | [HAL](https://hal.cs.princeton.edu/) 按 Agent、Model、Benchmark 展示表现与成本；[OpenHands Index](https://hub.openhands.dev/blog/openhands-index) 明确固定框架后比较模型 | 标题写清 `harness + model + method revision`；支持固定模型比较 harness，或固定 harness 比较模型 |
| 8. 用内容版本识别方法 | [Weave](https://docs.wandb.ai/weave/reference/python-sdk) 对内容变化创建对象版本 | 方法包、配置、CLI 版本或 policy 权重变化应产生可区分的 revision，不能只靠方法名称 |
| 9. 结果连接到产生它的版本与输入 | [W&B lineage](https://forge.coreweave.com/wandb/team-jdoc/wandb-webinar-cicd-2024/reports/Optimizing-CI-CD-model-management-and-evaluation-workflows-with-Weights-Biases--Vmlldzo5NTE1NjE5) 关联产物与 Run；[MLflow](https://mlflow.org/docs/latest/tracking/tracking-api/) 记录代码版本及父子 Run | 从成绩点打开报告，再追到方法快照、Trial、日志与产物；关系必须有明确来源 |
| 10. 比较落到改善和退步的样本 | [Braintrust](https://www.braintrust.dev/articles/how-to-score-individual-fields-in-llm-document-extraction) 对齐测试案例；[LangSmith](https://docs.langchain.com/langsmith/compare-experiment-results) 提供退步、改善筛选与输出 diff | 默认展示配对任务的 Δ，并允许直接进入退步 Trial，比较轨迹与配置 |
| 11. 首页帮助继续工作，并给出第一个动作 | [GitHub Dashboard](https://docs.github.com/en/enterprise-cloud%40latest/account-and-profile/get-started/personal-dashboard-quickstart) 提供近期工作；[Grafana](https://grafana.com/tutorials/grafana-fundamentals/) 用 Home 引导开始 | 已有数据时展示进行中评测和待复盘失败；无数据时给出选择 Benchmark、配置 Agent、运行首个评测的入口 |
| 12. 保存版本，并明确反馈集的边界 | [Kaggle](https://www.kaggle.com/docs/competitions) 将提交关联 Notebook 版本，并区分公开反馈与最终留出评估 | 区分开发子集、失败回归集、完整评测；只补跑失败题所得的成绩不能冒充全量进步 |

补充边界：VS Code 的确使用图标 Activity Bar，并通过 hover 展示名称和快捷键，同时打开有上下文的 Primary Side Bar。Orbit 可以保留这种紧凑模式，但首次使用应直接显示文字。[官方教程](https://code.visualstudio.com/docs/editing/getting-started/editor-tutorial)

## 2. 推荐的信息架构

### 当前基础与问题

- [App.tsx](/disk/disk_20T/wangxuehai/orbit/packages/web/src/App.tsx) 的一级入口是 Runs、Compare、Bench、Resources、Settings；名称放在 tooltip 中。
- [Jobs.tsx](/disk/disk_20T/wangxuehai/orbit/packages/web/src/pages/bench/Jobs.tsx:21) 默认打开 Evaluations，Catalog 位于第二个标签页。
- [Catalog.tsx](/disk/disk_20T/wangxuehai/orbit/packages/web/src/pages/bench/Catalog.tsx:76) **已经有登记计数、类别分组、校准与真实方法记录**；领域缺少独立筛选，并与 profiles 混排。
- [Settings.tsx](/disk/disk_20T/wangxuehai/orbit/packages/web/src/pages/Settings.tsx:26) 只筛出 Codex、Claude Code，没有展示完整 Agent 注册表。

### 一级导航

图标名表示建议形状，实施时优先扩展现有 `icons.tsx`。

| 顺序 | 中文名称 | English label | 图标建议 | 内容与理由 |
| --- | --- | --- | --- | --- |
| 1 | 概览 | Overview | `LayoutDashboard` | 回答平台覆盖、当前工作、最近变化和下一步 |
| 2 | 基准 | Benchmarks | `Library` | 把可评测对象作为显著入口；承载 Catalog、领域与类别分面 |
| 3 | 智能体 | Agents | `Bot` | 展示 harness 注册表及本机证据，与 Benchmark 形成对称入口 |
| 4 | 方法 | Methods | `GitBranch` | 展示 harness / policy、配置、版本及迭代关系 |
| 5 | 实验 | Experiments | `Flask` | 包含 `Evaluations`、`Runs` 两个标签，兼顾刷榜与日常科研 |
| 6 | 资源 | Resources | `Cpu` | 查看容量、租约、排队原因及节点 |
| 7，底部 | 设置 | Settings | `Settings` | 保存认证管理、通知、存储及界面偏好 |

Compare 放在实验和方法的上下文操作中，保留现有深链接。Trial、Run 详情保持独立页面，不再增加一级入口。

这是推荐终态。首期可先将 Methods 放在 Experiments 内；方法版本数据交付后再提升为一级入口，避免出现没有内容的新页面。

### 首页应回答的问题

1. **能评测什么？** 登记了多少 Benchmark、覆盖哪些 C1–C7 和领域；多少有校准证据。
2. **能用谁来跑？** 有哪些 harness / external 方法，当前缺安装、认证还是能力接线。
3. **现在发生什么？** 哪些评测运行中、为何排队、哪些结果需要复盘。
4. **最近改进了什么？** 哪个方法版本在同一 Benchmark 上改善或退步。
5. **下一步做什么？** 继续评测、查看失败、复制配置、创建下一方法版本。

```text
Orbit                 Overview                         [New evaluation]
──────────────────────────────────────────────────────────────────────
▦ 概览                Benchmarks R   Categories K/7   Domains D
▤ 基准                Sample-calibrated C   Real-method runs A
♙ 智能体              Agents H       Verified with evidence V
⑂ 方法
⚗ 实验                Start: [Benchmark ▼] × [Method / Agent ▼]
▣ 资源                Compatibility: reason / evidence → [Configure]
                       ───────────────────────────────────────────────
                       In progress       Needs review
                       job / progress    trial / failure / evidence
⚙ 设置                Recent method changes → paired results
```

初次使用展示可跳过的步骤清单：发现 Benchmark → 配置认证 → 选择兼容组合 → 运行。认证录入继续遵守现有 CLI 路径。

## 3. Benchmark 视图

### 三个信息层次

| 维度 | 回答的问题 | 规则 |
| --- | --- | --- |
| `category` | 被测对象怎样与任务交互？ | C1–C7，单个协议变体取一个类别 |
| `domains` | 任务涉及什么领域或场景？ | 多选，允许交叉 |
| `profiles` | 使用什么环境、动作或评分条件？ | 继续沿用各类别的受控词表 |

类别保留现有定义，不按领域重分：

| 类别 | English identifier | 用户可见名称 |
| --- | --- | --- |
| C1 | `fixed-input` | 固定输入响应 |
| C2 | `agent-workspace` | Agent 工作区 |
| C3 | `tool-workflow` | 工具 / API 工作流 |
| C4 | `user-session` | 模拟用户会话 |
| C5 | `gui` | GUI 交互 |
| C6 | `embodied-policy` | 具身策略闭环 |
| C7 | `game` | 游戏与多主体 |

关键例子：**EFE 是 C2＋具身领域；原生 LIBERO 是 C6＋具身领域。** HumanEval 的代码生成属于 C1，不能因为涉及软件就归 C2。

### 建议的受控领域词表

这是一组实用检索标签；每个 Benchmark 通常选 1–3 个。缺失标签显示“未标注”，不要自动写成 `general`。

| Identifier | 中文标签 | 范围 |
| --- | --- | --- |
| `science` | 科学研究 | 科学问题求解、研究复现、研究报告 |
| `software` | 软件与代码 | 编程、仓库修改、系统与开发任务 |
| `machine-learning` | 机器学习 | 训练、后训练、模型优化 |
| `data-analysis` | 数据分析 | 数据处理、统计分析、数据洞察 |
| `gui-web` | GUI / 网页 | 浏览器、桌面、移动应用任务 |
| `embodied` | 具身与机器人 | 物理环境、机器人、仿真控制 |
| `games` | 游戏 | 规则游戏、对局、游戏式规划 |
| `conversation` | 对话与服务 | 对话协作、客户服务 |
| `general` | 综合任务 | 明确跨多个领域的通用任务集 |

`biology`、`chemistry`、`physics`、`airline`、`retail` 等保留为细分标签。`browser`、`desktop`、`mobile` 继续属于 profiles。

现有 [`domains` 契约](/disk/disk_20T/wangxuehai/orbit/packages/orbit/src/contracts/bench.ts:201) 是自由字符串数组。建议先建立别名映射和编辑校验，兼容已有标签；后续契约扩展再区分受控领域与细分标签，保留原始声明及来源。

### 与现有 adapter / Benchmark 的对应

下表的领域是**建议标注**，不是声称 adapter 已经输出这些字段；类别依据当前接入规范，缺失声明应补齐。

| Benchmark / 实现 | 类别 | 建议领域 | 需要保留的区别 |
| --- | --- | --- | --- |
| HumanEval | C1 | `software` | 当前只接受 oracle、empty、external，不能直接承诺 CLI Agent |
| EFE / Harbor | C2 | `embodied` | `embodied-program` / `embodied-live`；35 suites 不算35次独立接入 |
| Terminal-Bench Science | C2 | `science` | 科学细分领域来自任务元数据 |
| TB 4.0 / Harbor | C2 | `general`，逐任务补领域 | 具体领域分布未逐题核验 |
| ASI-Bench | C2 | `science` | 原生 runner 限制需显式展示 |
| ResearchClawBench | C2 | `science` | LLM judge、无通用 oracle |
| LongDS | C2 | `data-analysis` | 按任务细分；不要统一标为科学研究 |
| PostTrainBench | C2 | `machine-learning` | 下游测试集名称不增加顶层 Benchmark 数 |
| BFCL multi-turn | C3 | `general` | MCP 是能力要求；CLI scaffold 与原榜协议不同 |
| τ²-bench airline / retail | C4 | `conversation` | 现有 domains 是 airline、retail；目前仅校准方法 |
| MiniWoB++ / BrowserGym、CUA-Lite | C5 | `gui-web` | 同源同协议时按一个 Benchmark、多个实现展示 |
| WebVoyager、Online-Mind2Web / CUA-Lite | C5 | `gui-web` | 各自独立身份；live、judge、资产限制保留 |
| Cua Bench、OSWorld-V2、MobileWorld | C5 | `gui-web` | 分别保留身份；desktop / mobile 是 profiles |
| LIBERO / vla-eval、manifest | C6 | `embodied` | Python adapter 与 manifest 不重复计数；尚无真实 policy 正向验证 |
| TextArena 单人游戏 | C7 | `games` | 当前38个游戏按现有集合展开，不直接宣传为38个独立接入 |

### 计数口径

- **首期立即显示** `Registered R`，取 Catalog entries 数量，明确它是登记数。
- 后续增加稳定身份：原始来源、版本、协议变体；区分 Benchmark 数、variant 数和 registration 数。
- 同一 Benchmark 的多个 adapter 不重复计入覆盖；不同实质交互协议作为 variant。
- 分开展示“协议支持任务”“抽样校准通过”“真实方法运行记录”“原生 / 官方对照”，沿用 [§9.15](/disk/disk_20T/wangxuehai/orbit/docs/design.md:1042)。
- `supported` 不代表本机资源已满足；校准显示样本量、版本、日期和偏差。
- 类别覆盖显示 `K/7`，领域显示已标注数量；未声明、listing 失败和陈旧数据单独计数。
- 领域允许多标签，因此领域计数之和可能超过总数。

```text
Benchmarks                         R registered   C sample-calibrated
[Search name / source...]          [List ●] [Coverage matrix ○]
────────────────────────────────────────────────────────────────────
Category              Domain                  Evidence
☐ C1 Fixed input (n)  ☐ Science (n)            ☐ Calibrated (n)
☐ C2 Workspace   (n)  ☐ Software (n)           ☐ Real method ran (n)
...                   ☐ Embodied (n)           ☐ Parity evidence (n)
☐ Unclassified  (n)  ☐ Unlabelled (n)

Active: [C2 ×] [Embodied ×]                    Showing x / R
Benchmark     Category  Domains   Supported/listed  Calibration  Action
EFE           C2        embodied  n / m             sample/date  Evaluate
  > suites / variants / implementations / deviations / evidence
```

矩阵作为可切换的覆盖视图；格子表示“登记 variant 数 / 抽样校准通过数”，点击后进入同一列表。

```text
                 Science  Software  GUI/Web  Embodied  Games  Conversation
C1 Fixed input      r/c      r/c       r/c       —        —        r/c
C2 Workspace        r/c      r/c       r/c      r/c       —         —
C3 Tool workflow    r/c      r/c       r/c       —        —        r/c
C4 User session      —        —         —        —        —        r/c
C5 GUI              r/c      r/c       r/c       —       r/c       r/c
C6 Embodied          —        —         —       r/c       —         —
C7 Game              —        —        r/c       —       r/c        —
```

矩阵表达覆盖关系，不表达成绩；`—` 表示当前筛选下没有登记项。

## 4. Agents（harness）视图

### 列、状态与详情

主表展示全部12个内置定义及用户定义：`codex`、`claude-code`、`pi`、`opencode`、`kimi-cli`、`gemini-cli`、`aider`、`goose`、`qwen-code`、`copilot-cli`、`mini-swe-agent`、`dsh`。

| 字段 | 展示方式 |
| --- | --- |
| Agent | 显示名、稳定 identifier、builtin / user |
| 安装与版本 | `Host available`、`Host missing`、`Installs in run`、`Provided by image`；版本未知直接标明 |
| 本机验证 | 有证据 / 未验证 / 最近验证失败；附节点、CLI版本、日期和 Run 链接 |
| 能力 | `oneShot`、`multiTurn`、`mcp`、`gui`，区分声明、接线、实跑证据 |
| 认证 | profile 数量；未配置、已配置未测试、最近成功、最近失败、信息陈旧 |
| 在哪里跑过 | Benchmark 数、Job / Run 数、最近记录；可过滤到具体 Benchmark |
| 操作 | 查看定义、配置认证、检查可用性、显式运行测试、开始评测 |

详情标签建议为 `Overview / Capabilities / Compatibility / Auth / Runs`。认证管理复用现有 API，密钥录入继续走 CLI。

**当前证据缺口必须修正：**

- 文档记录 Codex、Claude Code、dsh 曾真实运行；[`verified` 默认值](/disk/disk_20T/wangxuehai/orbit/packages/orbit/src/harness/registry.ts:152) 只对前两者硬编码为 true，不能直接用作当前机器的验证证明。
- `available=true` 对容器内安装和镜像提供型表示具备启动路径，不代表已安装或已成功运行。
- 多个定义声明 `mcp=true`，实际 `command.mcp` 仍为 `none`；应显示“Declared · not wired”。
- Settings 中认证测试结果保存在组件状态；长期状态需要可追溯的测试记录，不能拿 profile 更新时间冒充测试时间。
- 当前 CLI 是 `orbit agent check`；定义注释中的 `orbit agent test` 尚无对应命令。

```text
Agents     H registered    V verified with evidence    U unverified
[Search...] [Capability ▼] [Verification ▼] [Auth ▼]

Agent        Installation       Verification        MCP            Auth
Codex        host / version     evidence or unknown  wired          profiles/test
Claude Code  host / version     evidence or unknown  wired          profiles/test
OpenCode     installs in run    unverified           declared only  profiles/test
...

Selected: OpenCode
Capabilities: oneShot declared · multiTurn declared · MCP not wired · GUI no
Ran on: [Benchmark → Job → Trial]             [Check] [Configure] [Evaluate]
```

### 兼容矩阵

兼容判断应复用 daemon 的提交校验：`methods` 准入、`requires`、实际接线、方法配置，再结合环境条件。不要仅按类别或 Agent 名称推断。

特别注意：一次 CLI 会话内的多轮工具循环，不等于必须使用 CLI 的跨调用 `resume` 能力。

```text
                         Codex   Claude Code   OpenCode   external
TB-Science               A       A             A          B
BFCL multi-turn          E*      A             B:mcp      B
MiniWoB / CLI bridge     B:gui   E*             B:gui      A*
HumanEval                B       B             B          A*
τ² current adapter       B       B             B          B
LIBERO                   B       B             B          A*
```

`A`＝协议准入，尚需检查配置与环境；`B`＝明确阻止并说明原因；`E*`＝文档记载的特定抽样实跑；`A*`＝还依赖 adapter 解释的 external 配置。这张表不代表当前认证或本机就绪状态。

实际界面还需 `Unknown`。每格可展开：要求、缺项、证据范围、最近检查时间；当前认证失败作为独立运行阻碍展示。

Agents 页保留 `CLI harnesses / External methods` 的范围切换。`external` 是 adapter 所有的入口，能力来自具体协议；`policy` 当前是不可运行的保留名。

空状态分别处理：没有用户定义、没有认证、没有验证证据、没有兼容组合、筛选无结果。每种状态提供对应动作；内置定义始终可发现。

## 5. “迭代进化”如何体现

### 方法版本是结果的共同索引

当前 [`methodKey()`](/disk/disk_20T/wangxuehai/orbit/packages/orbit/src/bench/catalog.ts:25) 只按 `agent/model/effort` 或 external entrypoint 分组，会合并不同 bundle、配置及权重。

建议增加以下元数据，属于后续实现：

- `methodId`、不可变 `revision`、内容 `digest`、可选 `parentRevision`、变更说明。
- 快照包含 harness 定义、实跑 CLI 版本、model、effort、bundle 内容；external 包含入口、配置、镜像及权重版本。
- 认证保存公开引用与相关运行条件，凭据值不进入方法指纹。
- `informedBy` 引用失败 Trial；派生关系由人或 Agent 显式记录。
- 复用现有 Job、Run、报告修订和记录体系；无需新增实验状态机。
- `Run.parentId` 保持现有续跑语义，方法派生关系单独命名。

### 同一 Benchmark 上看版本和时间

默认选择 Benchmark、版本、任务集合、指标及聚合口径，再展示方法曲线。配置变化超过方法本身时，应分组或提示条件差异。

```text
Method: research-agent                  [Versions] [Results] [Lineage]
Benchmark: TB-Science@commit  Tasks: frozen-set  Metric: resolved ↑
Aggregation: [Official ○] [Orbit valid-only ●]    Baseline: v1

score
 .60 |                    ● v3
 .50 |          ● v2
 .40 |  ● v1
     +------------------------------------------------ time
        job-A      job-B       job-C
        valid/total · sample scope · report revision at every point

Revision   Change             Result / CI    Paired Δ    Regressions
v1         baseline           ...            —           —
v2         tool instructions  ...            ...         [Open trials]
v3         recovery strategy  ...            ...         [Open trials]
```

每个点打开不可变报告修订；重复运行保留分布。无效或缺失结果显示空缺及原因。Rescore 更新评分修订，方法版本保持不变。

比较固定任务 / 初态 / seed、预算、网络、观测动作权限及 scorer / judge 版本；使用现有配对统计。只在有记录时展示成本，缺失显示 `Unknown`。

### 从失败 Trial 到下一方法

```text
Trial failure → evidence → diagnosis / hypothesis
                               │
              ┌────────────────┴─────────────────┐
              ▼                                  ▼
       invalid: infrastructure             valid: method failure
       fix environment / auth              revise bundle / policy
       retry same method                   create revision v2
              │                                  │
              └──────── regression run ──────────┘
                               │
                   paired comparison + new failures
                               │
                 confirm on broader / held-out tasks
```

Trial 页提供“记录改进假设”“基于此方法创建下一版本”“复制上下文给 Agent”。上下文包含 Trial 链接、失败类别、证据与配置差异。

C3/C4 复用现有对话检查器，C5 复用截图与动作轨迹，C6 复用 episode 时间线，代码任务连接 diff 与终端。改进记录应能直接跳回这些证据。

只补跑失败任务时标记 `Partial / Regression subset`；它可以证明修复效果，完整成绩仍需相应评测集合。

## 6. 不建议做的事情与风险

- **跨 Benchmark 总分、均分或总榜**：尺度、分母和协议不同；按 Benchmark 并列展示。
- **一个 Ready / Healthy 徽章包办所有状态**：能力、安装、认证、资源、校准、有效性和清理分别展示。
- **按 hub 宣传数字统计接入量**：Harbor、BrowserGym、vla-eval 是实现来源；套件、任务、初态分别计数。
- **把抽样验证扩展为全部能力保证**：保留方法、任务范围、机器、版本、日期和条件。
- **跨版本直接连趋势线**：Benchmark、scorer 或条件变化可能制造虚假的方法进步。
- **从名称和时间猜 lineage**：不能证明因果的记录只显示时间顺序；没有证据不能补零或推测成功。
- **自动把失败都变成新方法**：认证或基础设施重试应保留原方法；Rescore 与重跑 Agent 分开命名。
- **首期建设完整模型市场、复杂自由布局或全屏关系图**：先完成目录发现、兼容解释和结果闭环。
- **把科研编排搬进 Web**：Orbit 继续提供执行与记录；改进由人和 Agent 主导。

建议实施顺序：**P0** 文字侧栏、Benchmarks 独立入口、领域分面、完整 Agents；**P1** 验证证据、方法内容版本和版本比较；**P2** 显式改进关系及从失败创建下一轮的操作。

## 7. 参考来源与核验限制

| 主题 | 官方来源 |
| --- | --- |
| Hub 分面与元数据 | [Hugging Face Datasets](https://huggingface.co/datasets)、[Dataset Cards](https://huggingface.co/docs/hub/en/datasets-cards)、[Inspect Evals](https://ukgovernmentbeis.github.io/inspect_evals/) |
| Registry、能力与公平条件 | [Harbor Hub](https://hub.harborframework.com/datasets)、[Harbor Agents](https://docs.harborframework.com/agents/pre-integrated-agents)、[Terminal-Bench 条件说明](https://www.tbench.ai/news/leaderboard-integrity-and-timeouts) |
| Benchmark 身份与浏览 | [Epoch Benchmarking](https://epoch.ai/benchmarks)、[OpenCompass 配置](https://doc.opencompass.org.cn/user_guides/datasets.html)、[Papers with Code 数据](https://github.com/paperswithcode/paperswithcode-data) |
| Harness 与 Model | [HAL](https://hal.cs.princeton.edu/)、[OpenHands Index](https://hub.openhands.dev/blog/openhands-index)、[LiteLLM AI Hub](https://docs.litellm.ai/docs/proxy/ai_hub) |
| 实验追踪与版本 | [MLflow Tracking](https://mlflow.org/docs/latest/tracking/)、[Weave 对象版本](https://docs.wandb.ai/weave/reference/python-sdk)、[Weave UI 比较](https://forge.coreweave.com/wandb/wandb_fc/product-announcements-fc/reports/Run-LLM-evaluations-right-in-the-W-B-Weave-UI--VmlldzoxNDM1MzUzNw) |
| 样本比较与反馈 | [Braintrust](https://www.braintrust.dev/articles/how-to-score-individual-fields-in-llm-document-extraction)、[LangSmith](https://docs.langchain.com/langsmith/compare-experiment-results)、[Kaggle](https://www.kaggle.com/docs/competitions) |
| 导航与初次使用 | [Linear](https://linear.app/changelog/2024-12-18-personalized-sidebar)、[GitHub](https://docs.github.com/en/enterprise-cloud%40latest/account-and-profile/get-started/personal-dashboard-quickstart)、[Vercel](https://vercel.com/changelog/dashboard-navigation-redesign-rollout)、[Grafana](https://grafana.com/docs/grafana/latest/whatsnew/whats-new-in-v9-3/)、[VS Code](https://code.visualstudio.com/docs/editing/getting-started/editor-tutorial) |

核验限制：

- **HAL 部分核验**：官方搜索索引提供了页面内容；直接访问返回403，未验证当前交互。
- **Papers with Code 当前旧版界面未核实**：本次 `/sota` 跳转至 Hugging Face Trending Papers；仅采用其公开数据关系，不声称旧分类界面仍在线。
- **W&B、Braintrust 部分文档抓取失败**：相关结论使用可访问的 SDK 文档及官方产品文章；未登录这些产品实测交互。
- **Orbit 本机状态未核验**：实际登记总数、认证状态和有效验证证据均待 daemon 数据支持；文档中的历史运行不等于当前就绪。

验证结果：源码与契约核对 **passed**；公开资料核验 **passed，限制如上**；`pnpm verify` **not_run**，此次仅调研、无代码改动。分支与提交保持 `main@5b2343e`，已有 `.gitignore` 修改未触碰。