# Web UI 调研：Catalog 与 C3/C4 对话视图

由 Codex（gpt-6.1-sol）读取 Orbit Web 源码并联网查阅官方文档与源码后写成（2026-11-05，基线 `main@9f3bc0f`）；第三方结论未登录产品逐项操作。取舍见 [design.md §9.15](../../design.md)。

**建议优先补两块：按 C1–C7 分组、能追溯验证证据的 Catalog；以轮次为主线、能联动 checker 与状态差异的 C3/C4 trial 视图。** 现有方法矩阵、统计口径、Run、Agent session 和 GUI/具身查看器应继续复用。

调研基线：`main@9f3bc0f`；已阅读指定 Web 文件、三份业务文档及相关契约、适配器。第三方结论依据官方文档和源码，未登录产品逐项操作；线框、尺寸和 Orbit 键位均为设计建议。

## 1. 结论：最值得借鉴的 10 个模式

| 优先级 | 模式、来源 | 在 Orbit 中怎么用 |
|---|---|---|
| P0-1 | **把结果与其证据一起展示。** HELM 提供 prompt 级透明度；HF 区分模型 commit、precision 和结果明细。[HELM](https://crfm.stanford.edu/helm/capabilities/latest/)、[HF FAQ](https://huggingface.co/docs/leaderboards/en/open_llm_leaderboard/faq) | 一行同时回答“能跑多少、校准了多少、真实方法跑过没有、与原生结果对过没有”。不要用一个绿色 `Integrated` 概括这些事实。 |
| P0-2 | **总览用紧凑分组表，详情逐层展开。** Linear 支持分组、排序和显示字段；过滤与隐藏字段是两件事。[Linear](https://linear.app/docs/display-options) | Catalog 默认按类别分组，每个 benchmark/variant 一行；详情展开后显示 suite、阻塞原因、校准检查、方法成绩和偏差。 |
| P0-3 | **校准采用具名检查列表。** GitHub Actions 从 run 下钻到 job、失败 step 和日志；Vercel checks 区分执行状态与结论。[GitHub Actions](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs)、[Vercel](https://vercel.com/docs/checks/creating-checks) | 每项显示 `passed / failed / not_run`、期望、实际、适用范围和证据链接；直接打开失败 trial。 |
| P0-4 | **对话是主视图，tree 是辅助视图。** Laminar 默认 transcript；LangSmith 的 Trajectory 将模型响应、调用和结果放在同一轮。[Laminar](https://laminar.sh/docs/platform/viewing-traces)、[LangSmith](https://docs.langchain.com/langsmith/view-traces) | C3/C4 默认按用户轮次阅读，工具调用嵌在轮内；无需先展开多层 span 才看到内容。 |
| P0-5 | **checker verdict 联动具体证据。** Inspect 把消息、提取答案、评分解释分开呈现；Docent 的分析引用能跳到原始 transcript。[Inspect](https://inspect.aisi.org.uk/log-viewer.html)、[Docent](https://transluce.org/docent/blog/terminal-bench) | 顶部突出失败类型；点击后定位对应轮次、状态字段或缺失响应。明确区分“首次检测到失败的位置”和“推测根因”。 |
| P0-6 | **调用与结果组成一张可折叠卡片。** Harbor 源码通过调用标识关联 observation；LangSmith 将调用卡片连到详细 run。[Harbor 源码](https://github.com/harbor-framework/harbor/blob/main/apps/viewer/app/routes/trial.tsx)、[LangSmith](https://docs.langchain.com/langsmith/view-traces) | 卡片标题显示调用者、工具名、参数摘要、结果/错误；展开查看完整参数、返回和原始记录。按 `callId` 关联，不能依赖消息相邻。 |
| P0-7 | **并列提供两种 diff。** Weave 支持并排、统一、只看差异及 baseline；BFCL 官方评测检查状态和工具响应。[Weave](https://docs.coreweave.com/products/wandb/weave/guides/tools/comparison)、[BFCL](https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html) | 分清“执行前→执行后”和“期望→实际”。参考调用文本的不同只作诊断，不自行变成判分规则。 |
| P1-8 | **从同题成绩直接进入双方法复盘。** Langfuse 支持逐项并排输出，并在比较表旁打开 trace；Braintrust 提供输出 diff。[Langfuse](https://langfuse.com/docs/evaluation/experiments/compare-experiments)、[Braintrust](https://www.braintrust.dev/foundations/comparing-experiments) | 保留现有配对统计；增加同 task 的双 trial 查看器，优先浏览“基线通过、候选失败”的题。 |
| P1-9 | **保留筛选上下文，提供连续审阅。** Inspect 可按成绩过滤、把同一样本的多次运行放一起；Weave 支持 trace 搜索和键盘导航。[Inspect](https://inspect.aisi.org.uk/log-viewer.html)、[Weave](https://docs.coreweave.com/products/wandb/weave/guides/tracking/trace-tree) | 从筛选列表进入 trial 后，继续上一题、下一题、下一失败；返回时恢复列表、滚动和筛选。 |
| P1-10 | **健康历史显示“检查发生过什么”，不制造连续健康。** Grafana `Status history` 保留离散状态块，不合并相邻相同结果。[Grafana](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/status-history/) | 后续有多次校准记录时，显示最近几次检查及其版本；没有检查的时间段留空，不能画成持续绿条。 |

上述产品中，本次**未核实到一个现成页面同时覆盖 Orbit 的全部校准要求**。Catalog 的检查模型应来自 Orbit 自己的校准契约，借鉴第三方的是组织与下钻方式。

## 2. Catalog / 校准总览页

### 调研中可直接转用的模式

| 产品 | 已核实的呈现方式 | 可迁移之处与边界 |
|---|---|---|
| HELM | 模型成绩表、多场景/指标、版本及 prompt 级结果透明度。 | 借鉴矩阵与证据下钻；不能把它的跨模型榜单直接当作接入健康页。[来源](https://crfm.stanford.edu/helm/capabilities/latest/) |
| Hugging Face | 搜索过滤、列可见性、raw/normalized 分数切换、commit/precision 区分、结果明细。 | 显示成绩口径和方法版本；原 Open LLM Leaderboard 已结束运营，应作为历史设计参考。[FAQ](https://huggingface.co/docs/leaderboards/en/open_llm_leaderboard/faq)、[结束公告](https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard/discussions/1135) |
| lm-eval-harness | `--check_integrity`、配置与逐样本输出；可接 W&B/Zeno 查看。 | 借鉴“汇总背后有配置和样本”；未核实独立内置健康仪表盘。[来源](https://github.com/EleutherAI/lm-evaluation-harness#visualizing-results) |
| OpenCompass | 结果表、有效配置快照，infer/eval 日志分开；缺失结果显示 `-`。 | 缺失不能补 0；执行与评分证据分开。当前文档主要说明结果文件与汇总，不能据此断言有完整交互式校准 UI。[来源](https://opencompass.readthedocs.io/en/latest/user_guides/results_and_summarizer.html) |
| Braintrust | 实验列表展示成绩、错误数、耗时和成本；可过滤、搜索、按 metadata 分组。 | 主表紧凑，异常可筛出；评分解释与输出一起审阅。[来源](https://www.braintrust.dev/foundations/how-to-analyze-your-eval-results) |
| Weave | 选择多个 evaluation，选择显示指标，逐样本比较同一输入。 | 复用 Orbit 已有比较结构，增加可选列与样本复盘入口。[来源](https://docs.coreweave.com/products/wandb/weave/guides/evaluation/evaluation_logger) |
| Langfuse | 明确 baseline、数据/评估器版本；按成绩阈值筛选，并排输出及 trace 侧栏。 | 比较前说明条件差异；最新运行不自动成为可信基线。[来源](https://langfuse.com/docs/evaluation/experiments/compare-experiments) |
| Phoenix | 实验与 trace 关联；Harbor 集成将任务版本、方法实验、reward 和 `infra_ok` 分开记录。 | 保留“任务正确性”和“设施正常”两个判断，不能混成一个通过率。[来源](https://arize.com/blog/ai-agent-benchmarking-harbor-arize-phoenix/) |

### 推荐信息架构

入口继续放在 **Bench** 内：`Catalog | Evaluations`。将现在的 `Registered environments` 升级为 Catalog，不新增一级导航图标。

默认分组：

`C1 固定输入 → C2 工作区 → C3 工具工作流 → C4 模拟用户 → C5 GUI → C6 具身策略 → C7 游戏`；旧记录无法确定类别时进入“类别未记录”，不猜测。

| 默认列 | 内容 |
|---|---|
| Benchmark / variant | 登记名称、原始 benchmark 身份；副行显示版本、必要 profile。hub 作为实现信息。 |
| Runnable | `supported / listed tasks`；附“依赖声明条件”，不是本机启动成功数。 |
| Calibration | 检查结论、抽样任务数/范围；部分校准明确写“抽样”。 |
| Real methods | **实际运行过**的真实方法数量/名称，与“支持的方法”分开。 |
| Latest scores | 最多显示两个置顶方法；指标名、单位、有效样本数、任务范围、日期，其他展开。 |
| Official fidelity | 原生对照是否执行、覆盖范围、是否存在偏差；未对照显示“未验证”。 |
| Evidence updated | 最近证据时间；版本变化后另标“需重新验证”。 |

顶栏提供搜索、类别、校准结果、有无真实方法、偏差/阻塞筛选。支持按名称、失败优先、证据时间排序；列显示选项不改变筛选范围。

```text
Bench / Catalog                             [Catalog] [Evaluations]
Registered N | Calibration failed N | No real methods N | Unverified parity N
[Search /________] [Category v] [Calibration v] [Issues only] [Columns]

v C3 Tool workflow
  Benchmark / profile  Runnable  Calibration       Real methods  Latest   Fidelity
> BFCL multi-turn      799/800   Passed · sampled   None          --       See evidence

v C4 Simulated user
> tau2 airline/retail   164/164   Offline replay    None          --       Sample replay

v C5 GUI
> OSWorld-V2            Listed   not_run · KVM      None          --       Unverified

展开某 benchmark：
+ Coverage | Calibration | Methods & scores | Fidelity | History ----------------+
| Check                Expected              Actual          Result   Evidence |
| Finished             all terminal          ...             passed   job      |
| Evaluation validity  all valid             ...             passed   trials   |
| Empty                declared expectation  ...             passed   trials   |
| Oracle               declared expectation  ...             passed   trials   |
| Repeat               exact / tolerance     ...             failed   trial -> |
| Cleanup              confirmed             ...             passed   runs     |
| Rescore              same saved evidence   not executed    not_run  reason   |
| Scope: task IDs / suites / seeds / source + scorer revision / checked at       |
+------------------------------------------------------------------------------+
```

示意中的覆盖数字来自仓库文档快照，不是本次 daemon 实时检查；没有填写真实方法成绩。

展开内容还应包含：

- **Coverage**：按 suite 展示支持数、unsupported 原因和条件；任务与初态/episode 数分开。
- **Methods**：支持但未运行、校准方法、真实方法分别标注；每条成绩链接 job/report。
- **Fidelity**：原生 runner 版本、同题对照范围、差值与容差、已知 deviations、证据位置。
- **History**：原检查记录保留；当前源码/配置/scorer 变化只影响其适用性，不抹掉历史通过事实。

### 几个必须明确的语义

1. **校准期望由 benchmark 声明。** Orbit 已支持 empty 非零、没有 oracle、重复容差和不同 seed 对应不同初态。不要把列标题永久写成 `empty=0 / oracle=1`。
2. `not_run` 必须显示原因：未执行、没有 oracle、该检查不适用等。当前校准逻辑允许部分 `not_run` 不阻止 `calibrated=true`，UI 应同时显示跳过项。
3. **`Official aggregation` 与 `Official parity` 分开。** 现有 `MethodCard` 的 `Official` 是按官方规则聚合本地 trial，并非官方公布成绩，也并非与官方 runner 对齐。
4. **接入方式与保真阶段分开命名。** 文档同时使用 L0–L2 表示 Harbor/Manifest/SDK，和 L0–L4 表示验证阶段。界面宜直接写名称，避免两个含义不同的 `L2` 徽章。
5. **最新尝试与最近可信成绩同时显示。** 最新运行 invalid 时，主状态显示异常；可以附上旧可信成绩，但必须标日期和“上次可信”，不能静默沿用。
6. 方法成绩按 benchmark/version、profile、任务集合与方法配置识别；仅凭 `method.name` 不能判断是同一个方法。

### 空状态与失败态

| 情况 | 推荐表现 |
|---|---|
| 没有登记 benchmark | 简短说明及现有 `orbit bench add …` 命令；不显示全绿健康概览。 |
| 已登记，没有校准记录 | “校准证据未记录”，可复制校准命令；不能根据 job 名称猜测通过。 |
| 没有真实方法运行 | “仅校准方法”；分数留空，不能把 oracle 满分放入真实方法成绩。 |
| 一个 adapter 无法列任务 | 保留该行，显示错误、最后成功读取时间和重试；不阻断整个目录。 |
| 校准失败 | 显示具体失败检查及受影响任务数；展开直接看到证据。 |
| 有分数但记录不完整 | 保留分数、有效性与缺失说明；不补造置信区间或官方对照。 |
| daemon 断开 | 保留已加载内容并标“连接断开/数据可能过时”；不把连接问题解释为 benchmark 失败。 |

## 3. C3/C4 对话与工具调用 trial 视图

### 查看器调研

| 产品 | 已核实的布局/交互 | 对 Orbit 的启发 |
|---|---|---|
| Inspect View | 样本列表→详情；Messages、Scoring、Metadata；按分数过滤、按样本/epoch 排序。 | 原始输出、提取结果和评分解释都保留；同题重复运行便于检查不一致。[来源](https://inspect.aisi.org.uk/log-viewer.html) |
| LangSmith | Trajectory 按轮展示响应、工具和结果；Details 查看准确 run；可搜索选中 run 已加载内容。 | 用对话定位，再进入底层详情；不要让每次下钻丢失会话上下文。[来源](https://docs.langchain.com/langsmith/view-traces) |
| Langfuse | Session 把多个 trace 连成会话；轮次侧栏、会话搜索、trace 侧栏。 | 保留跨轮阅读与单次执行详情之间的入口。[来源](https://langfuse.com/docs/observability/features/sessions) |
| Phoenix | trace 列表→执行树，查看系统提示、参数、工具结果和最终响应。 | 树适合检查父子关系和重复调用；不要用它取代用户轮次。[来源](https://arize.com/blog/add-observability-to-your-open-agent-spec-agents-with-arize-phoenix/) |
| Braintrust | trace 分层查看；实验比较支持同输入输出 diff、成绩解释和成本。 | 将行为证据和质量分数连接起来。[Trace](https://www.braintrust.dev/foundations/how-to-read-a-trace)、[比较](https://www.braintrust.dev/foundations/comparing-experiments) |
| OpenAI Evals / Agents SDK traces | 官方流程支持从 trace 创建 grader，再对一组 trace 执行评估。 | checker 结果应连接执行证据；本次未核实 dashboard 的精确快捷键和状态 diff 行为。[官方文档](https://developers.openai.com/api/docs/guides/trace-grading) |
| τ²-bench viewer | 源码有任务/轨迹选择、同任务 trial 切换、reward/assertion、消息与工具内容、URL 定位。 | 重复 trial 和任务定义入口值得借鉴；未在该组件核实双方法并排或完整 DB diff。[源码](https://github.com/sierra-research/tau2-bench/blob/main/web/leaderboard/src/components/TrajectoryVisualizer.jsx) |
| BFCL | 官方说明多轮状态/响应检查；checker 源码返回状态 differences 或缺失响应。 | 它首先提供判分语义；本次未核实独立的交互式 transcript viewer。[说明](https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html)、[checker](https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py) |
| Docent | 对比同题成功/失败轨迹；分析引用跳到原 transcript。 | 借鉴“结论有证据锚点”；自动根因分析可以后置。[来源](https://transluce.org/docent/blog/terminal-bench) |
| Weave | trace 表、树、选中节点详情三部分；搜索/过滤、键盘导航、多种结构/时间视图。 | 复杂执行可切树或 timeline；普通会话保持阅读顺序。[来源](https://docs.coreweave.com/products/wandb/weave/guides/tracking/trace-tree) |
| Harbor / Terminal-Bench | Harbor 查看器有工具参数/结果关联、轨迹、Verifier 文件和 Exception 入口。 | terminal 输出与判分日志分别展示，不能拿执行异常代替任务 verdict。[源码](https://github.com/harbor-framework/harbor/blob/main/apps/viewer/app/routes/trial.tsx) |
| AgentOps | 文档确认 trace/span、agent/tool 分层与 tags。 | 可借鉴角色与执行层次；本次未充分核实其当前 UI 的精确 diff、下一失败和快捷键。[来源](https://docs.agentops.ai/v2/concepts/core-concepts) |
| Laminar | 默认 transcript，调用有行内摘要；Tree 可切换，timeline 与内容联动，选中 span 打开右侧详情。 | 对话阅读优先，耗时与并发作为辅助。[来源](https://laminar.sh/docs/platform/viewing-traces) |

τ² viewer 的 `main` 已持续演进；这些是查看器设计参考，不能当成 Orbit 固定上游 commit 已具备的能力。

### 推荐主布局

桌面采用三栏：**轮次目录 / 对话 / 证据检查器**。Trial 列表作为可切换侧栏或抽屉，不永久增加第四栏。

```text
Bench / job / task · method · seed                       [Report rev v]
[< Trial] [Trial >] [Next failure] [Compare same task] [Back to filtered list]

Task not completed | evaluation: valid | execution: succeeded | cleanup: done
Checker: state mismatch · first detected at Turn 4       [Go to evidence]

[Conversation] [Grader] [Configuration] [Agent session] [Outputs]
+------------------+----------------------------------+--------------------------+
| Turns / Trials   | Conversation                     | Checker | State | Ref    |
| [Search /____]   | Turn 4 · native turn_index=3      |                          |
|                  | USER: ...                        | State check: failed      |
| 1  ...           | ASSISTANT: ...                   | Expected / Actual        |
| 2  ...           |                                  |                          |
| 3  ...           | v AGENT -> tool_name(args...)    | path       expect actual |
| 4! state mismatch|   callId: ...   result: returned | account.x  ...    ...    |
| 5  unchecked     |   [Arguments] [Result] [Raw]      |                          |
|                  |   {...}                          | [Changed fields only]    |
|                  |                                  | [Open verifier output]   |
|                  | ASSISTANT final response: ...    | Source: verify/replay    |
+------------------+----------------------------------+--------------------------+
```

以上失败内容为虚构示意。窄屏改为对话单栏，轮次抽屉和证据面板按需打开；不压缩成三个不可读的窄栏。

### 轮次与工具卡片

- **BFCL**：沿用原始 user turns 分组；一个 turn 内可有多次 assistant/tool 往返。界面轮次可从 1 开始，但详情保留原始索引。
- **τ²**：同一消息流中明确区分 `Agent`、`Simulated user`、`Agent tool`、`User tool`。上游消息具有 `requestor`，不能把全部工具操作归给 Agent。[消息契约](https://github.com/sierra-research/tau2-bench/blob/f8de30c298689cbe0117d76a378e7315a17e5bd8/src/tau2/data_model/message.py)
- 一行摘要优先显示工具名、关键参数和返回摘要；成功的大结果默认折叠，错误和 checker 相关内容默认展开。
- 同批调用可以折叠为一组，但分别保留调用标识、结果和错误；没有时间证据时不推断并发。
- 参数提供结构化与 Raw 两种查看方式；较长结果显示截断标志、完整查看和下载入口。
- 角色靠文字/图标识别；角色颜色与成功/失败颜色分开。
- thinking 仅在实际保存时提供，默认折叠；不补写未记录的模型思考。

### checker 失败定位与 diff

**需要同时区分三类事件：工具错误、任务判分失败、评估设施故障。** 工具返回错误后可能被 Agent 恢复；工具全部成功也可能任务失败。

| 面板 | 应展示什么 |
|---|---|
| Checker | 原始 `error_type`、解释、判分版本、检测范围、证据来源和链接。 |
| State transition | 保存的 before→after，默认只显示变化字段；注明快照粒度。 |
| Expected / actual | checker 比较的参考状态/响应与实际值；突出缺字段、类型差异和不匹配路径。 |
| Reference calls | 参考调用路径与实际调用的辅助 diff；清楚标明是否属于评分约束。 |
| Raw evidence | 原始 JSON/日志及定位路径，方便核对解释是否正确。 |

BFCL 的响应检查并不要求调用文本逐字一致；当前 checker 还允许响应来自此前轮次，并处理无序匹配。UI 不应将参考调用顺序的不同自行标成错误。[checker 源码](https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py)

**当前 Orbit 产物能支持到哪里：**

| 现有证据 | 可以直接支持 | 仍缺什么 |
|---|---|---|
| BFCL `evidence.json`、`replay.json` | 用户轮次、调用参数/结果/错误、可用工具、逐轮 before/after 状态。 | 目前参考 replay 在 verifier 内生成但未单独保存；不能默认完整参考轨迹已可读取。 |
| BFCL `verdict.json` | checker 类型、解释、部分 expected/actual differences。 | 部分 verdict 没有结构化失败 turn；先显示“未提供精确轮次”，不要猜。 |
| τ² `simulation.json`、`events.jsonl` | 消息、工具调用及结果的顺序、原始消息定位。 | 当前是校准重放，没有实际用户 LLM；不能呈现为真实模拟用户运行。 |
| τ² `context.json` | 初始与最终 DB 对比、环境/用户设定。 | 没有逐消息 DB 快照，不能画逐轮状态变化或归因到单条调用。 |
| τ² `reward.json` | 上游保存的 reward 与检查细项。 | 终态检查若没有 turn 锚点，只能定位终态或相关证据，不能宣称确定失败轮次。 |

对 BFCL，checker 在前面失败后，后续轮次没有被检查时应显示 `unchecked`，不能默认显示通过。对 τ²，未来接入 dual-control 时保留单一顺序主线，并标注双方工具权限与状态修改者。

### 同题双方法比较

```text
task / compatible conditions                Baseline A | Candidate B
                       [Only differences] [Next differing region]

Turn / milestone       A                            B
User request           ...                          ...
Tool activity          ...                          ...
State / checker        passed                       failed -> evidence
Final outcome          ...                          ...
```

- BFCL 可以按相同用户轮次对齐；工具数量不同要留空，不强行逐条配对。
- τ² 的用户回复会随 Agent 行为改变；按任务和语义阶段辅助对齐，允许独立滚动，不能把相同轮号当成相同输入。
- 比较时显露 task/data、scorer、方法、用户模拟器及配置差异。相同 seed 不保证相同对话。
- 保留现有配对统计与 `valid/total`；加入“同题只有单方结果”状态，避免只展示双方成功完成的题。

### 导航、键盘与 Agent session 的关系

建议延续现有键位习惯：

| 操作 | 建议键位 |
|---|---|
| 搜索当前会话 | `/` |
| 列表选择 | `j / k` |
| 上一/下一轮 | `h / l` |
| 上一/下一 trial | `[ / ]` |
| 下一失败 trial | `Shift+]`，同时提供可见按钮 |
| 跳到 checker 失败证据 | `e` |
| 下一/上一搜索命中 | `n / N` |
| 关闭抽屉/弹层 | `Esc` |

键位按当前焦点区域生效；输入框、JSON 编辑/搜索和弹层打开时不触发页面导航。URL 保存 trial、turn、call、证据面板与比较对象；返回列表恢复原筛选。

**评测对话与 Agent session 是两种记录。** `Session.tsx` 已区分宿主提交者和容器内 Agent；C3/C4 conversation 应来自 benchmark 的原生证据。保留 `Agent session` 排障入口，通过明确的调用/消息引用联动；没有映射就说明未关联，不能靠时间或消息顺序猜测。

## 4. 对现有 Web 的具体改进建议

### 按文件落点

| 位置 | 建议 |
|---|---|
| [App.tsx](/disk/disk_20T/wangxuehai/orbit/packages/web/src/App.tsx:48) | 保留现有 rail、主题和命令面板；Catalog 留在 `/bench` 内。如新增 `/bench/catalog`，须放在通用 `/bench/:id` 匹配之前。 |
| [Jobs.tsx](/disk/disk_20T/wangxuehai/orbit/packages/web/src/pages/bench/Jobs.tsx:181) | 将当前逐条 `Environment` 配置块扩成分组 Catalog；任务详情仍按需加载。主行直接显示覆盖与证据摘要。 |
| `pages/bench/Catalog.tsx`，拟新增 | 只承担目录表、筛选、展开；复用 `lib/category.ts`、表格和状态组件。不要在 Web 复制维护一份 `docs/catalog.md` 数据。 |
| [JobDetail.tsx](/disk/disk_20T/wangxuehai/orbit/packages/web/src/pages/bench/JobDetail.tsx:17) | 保留进度、方法成绩、Reports、TrialBrowser；增加同题比较和失败连续审阅入口。 |
| `MethodCard.tsx`、`Conditions.tsx` | 将 `Official` 解释为“官方聚合口径”；另设原生对照证据。已有“历史设置缺失”和条件差异提示应保留。 |
| [TrialBrowser.tsx](/disk/disk_20T/wangxuehai/orbit/packages/web/src/pages/bench/TrialBrowser.tsx:11) | 增加 failure kind、工具错误、checker 失败等结构化筛选；保持有效零分与 invalid 分开。当前比较/列表筛选不改变总体统计的说明值得保留。 |
| [Compare.tsx](/disk/disk_20T/wangxuehai/orbit/packages/web/src/pages/bench/Compare.tsx:20) | 保留 baseline、改善/退步和配对 CI；增加“打开同题双 trial”，避免先跳回两个 job 再找 seed。 |
| [Trial.tsx](/disk/disk_20T/wangxuehai/orbit/packages/web/src/pages/Trial.tsx:82) | 按声明的 review 类型选择 conversation；现在仅优先排列 `trajectory`。让结果摘要更紧凑，执行资源详情默认可折叠。 |
| `pages/trial/Conversation.tsx`，拟新增 | 建议内部分为轮次目录、调用卡片、checker/state 面板；继续通过已有产物 API 读取证据。 |
| [Session.tsx](/disk/disk_20T/wangxuehai/orbit/packages/web/src/pages/run/Session.tsx:29) | 复用消息、折叠和键盘模式；目前调用与结果分别渲染，且 `toolText()` 偏 shell 展示，不宜直接作为完整 C3/C4 查看器。 |
| [Trajectory.tsx](/disk/disk_20T/wangxuehai/orbit/packages/web/src/pages/trial/Trajectory.tsx:93)、`Episode.tsx` | 复用步骤链接、缺失证据、producer/trust/completeness 的表达；保留各自场景，不强塞进对话组件。 |
| [lib/review.ts](/disk/disk_20T/wangxuehai/orbit/packages/web/src/lib/review.ts:10)、`lib/api.ts` | 如增加 `conversation` kind，同步契约、解析、fallback 与测试；不按 benchmark 名称硬编码渲染。 |
| [styles.css](/disk/disk_20T/wangxuehai/orbit/packages/web/src/styles.css:2) | 延续现有 token；新增 conversation/catalog 样式放相邻模块 CSS，减少继续扩张全局文件。 |

### 数据前提

当前 `lib/api.ts` 没有校准报告专用接口；`CalibrationReport` 定义和判断逻辑位于 CLI。**Catalog 的可信校准状态不能只靠前端拼接已有 job 名称得到。**

建议复用现有 bench/report 体系保存检查结果、范围、期望与版本，再由 daemon 提供摘要；不另建独立健康账本。大型目录也不应在首屏对每一行调用 `benchInfo()` 并下载全部任务。

会话同样采用“原生产物＋统一索引映射”：保留 BFCL/τ² 原始格式，在索引中声明轮次、调用、状态和 verdict 引用。前端负责展示，评分仍由原 scorer 完成。

### 视觉风格

现有 Inter、JetBrains Mono、深浅主题、细边框和 30px 表格行已经适合本地评测工具，建议保留。

- Catalog 维持高密度表格；默认行约 32–40px，支持舒适密度。
- 会话正文建议 14px、行高约 1.6；JSON/工具内容 12–13px 等宽字。以上是建议值，未实测第三方 CSS。
- 正文、标题和次要信息形成层次；关键失败原因不要使用最淡的 `--text-3`。
- 蓝色表示选择/运行，绿色表示通过，红色表示失败，灰色表示缺失或未执行；同时带文字和图标。
- `valid` 的零分应标“任务未完成”，不能看起来像设施异常；工具 `returned` 也不能显示成任务成功。
- 长参数、工具结果只在局部展开；错误解释不要只藏在 tooltip。
- 状态 diff 用增删背景并配字段路径；不把整个失败会话染红。

### 不建议做的

- 不做跨 C1–C7 原始分数总榜或单一“总体健康分”。
- 不将注册成功、任务 listing、oracle 满分、真实方法运行、官方对齐混为一项。
- 不默认展开完整 JSON、全部成功工具结果或深层 trace tree。
- 不把双方法比较退化为两个独立页面，也不强制对齐动态会话的每个轮号。
- 不用动画角色图/关系图替代普通对话阅读；timeline 主要解决时间与并发问题。
- 不将缺失轨迹、未评分、未运行显示为 0；不从缺失字段推测成功。
- 不引入多用户权限、发布审批或生产监控套件来承载这个本地单用户需求。
- 不把 `Rescore` 表述为重跑 Agent、恢复环境或继续会话。

验证范围：源码与官方资料阅读 **passed**；`pnpm verify`、产品交互、Docker/模型/校准运行 **not_run**，因为本次为只读设计调研。未修改文件、未创建提交。

## 5. 参考来源

1. [HELM Capabilities](https://crfm.stanford.edu/helm/capabilities/latest/) — 成绩表、版本与 prompt 透明度；动态页面未交互核验。
2. [HF Open LLM Leaderboard FAQ](https://huggingface.co/docs/leaderboards/en/open_llm_leaderboard/faq) — 搜索、列、原始分数、方法版本。
3. [Open LLM Leaderboard 结束公告](https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard/discussions/1135) — 历史产品状态。
4. [lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness#visualizing-results) — 样本记录、可视化集成。
5. [OpenCompass outputs / summarizer](https://opencompass.readthedocs.io/en/latest/user_guides/results_and_summarizer.html) — 配置、结果与缺失值。
6. [Inspect Log Viewer](https://inspect.aisi.org.uk/log-viewer.html) — 样本、消息、评分解释、过滤。
7. [Braintrust 实验比较](https://www.braintrust.dev/foundations/comparing-experiments)、[分析结果](https://www.braintrust.dev/foundations/how-to-analyze-your-eval-results)、[读取 trace](https://www.braintrust.dev/foundations/how-to-read-a-trace)。
8. [Weave evaluation logging](https://docs.coreweave.com/products/wandb/weave/guides/evaluation/evaluation_logger)、[Trace view](https://docs.coreweave.com/products/wandb/weave/guides/tracking/trace-tree)、[Comparison](https://docs.coreweave.com/products/wandb/weave/guides/tools/comparison)。
9. [Langfuse 实验比较](https://langfuse.com/docs/evaluation/experiments/compare-experiments)、[Sessions](https://langfuse.com/docs/observability/features/sessions)。
10. [LangSmith 查看 traces](https://docs.langchain.com/langsmith/view-traces)、[Threads](https://docs.langchain.com/langsmith/threads)。
11. [Phoenix trace 查看](https://arize.com/blog/add-observability-to-your-open-agent-spec-agents-with-arize-phoenix/)、[Harbor 实验集成](https://arize.com/blog/ai-agent-benchmarking-harbor-arize-phoenix/)。
12. [OpenAI 官方 Trace grading](https://developers.openai.com/api/docs/guides/trace-grading)。
13. [BFCL 多轮评测说明](https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html)、[checker 源码](https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py)。
14. [τ² 固定版本 README](https://github.com/sierra-research/tau2-bench/blob/f8de30c298689cbe0117d76a378e7315a17e5bd8/README.md)、[消息契约](https://github.com/sierra-research/tau2-bench/blob/f8de30c298689cbe0117d76a378e7315a17e5bd8/src/tau2/data_model/message.py)、[现行 viewer 源码](https://github.com/sierra-research/tau2-bench/blob/main/web/leaderboard/src/components/TrajectoryVisualizer.jsx)。
15. [Docent Terminal-Bench 分析](https://transluce.org/docent/blog/terminal-bench)。
16. [Harbor trial viewer 源码](https://github.com/harbor-framework/harbor/blob/main/apps/viewer/app/routes/trial.tsx)。
17. [AgentOps Core Concepts](https://docs.agentops.ai/v2/concepts/core-concepts)。
18. [Laminar Viewing Traces](https://laminar.sh/docs/platform/viewing-traces)。
19. [GitHub Actions logs](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs)、[Vercel checks](https://vercel.com/docs/checks/creating-checks)。
20. [Linear Display options](https://linear.app/docs/display-options)、[Grafana Status history](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/status-history/)。