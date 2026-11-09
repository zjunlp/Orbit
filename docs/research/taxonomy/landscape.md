# Orbit 类别化集成规范：外部评测生态调研

> 历史调研说明（2026-11-09）：本文的类别、编号与界面建议保留调研时点语义，不再定义当前产品分类。
> 公开分类采用 [design §9.17 六维 v1](../../design.md#917-benchmark-六维分类-v12026-11-09)，每个维度有独立受控取值；
> C1–C7 仅保留为历史接入原型或兼容信息。来源、原始观察及验证限制保持不变；当前状态见 [status](../../status.md)。

调研日期：2026-11-04 至 2026-11-05（Asia/Shanghai）。本报告属于 external landscape track；只读查阅 Orbit 与外部官方仓库、文档、论文，没有运行评测，也没有修改被调研仓库。本文提出的分类和接口均为建议，不代表 Orbit 已实现。

**建议采用 7 个顶层类别：固定输入响应、工作区与产物、工具/API 工作流、模拟用户服务会话、GUI 交互、具身闭环控制、游戏与多主体环境。分类单位是“benchmark × evaluation profile”，首要依据是被评测系统的边界及其交互契约。** 领域、模态、scorer、是否联网分别作为独立属性。该建议来自下文对模型请求接口、工作区交付、工具循环、用户协同、GUI 和环境 step 接口的比较，不是某个现成框架的原样分类。[lm-eval 模型接口][lm-model]、[Harbor task][harbor-task]、[τ²-Bench 论文][tau2-paper]、[BrowserGym task][bg-task]、[VLA 架构][vla-arch]提供了不同边界的直接例证。

**证据口径。** 本文使用以下标记，避免把“官网写了”误报为“实现已验证”：

| 标记 | 含义 |
|---|---|
| **C** | 已阅读所引源代码，核实该段所述静态实现；运行行为、依赖组合和本机可用性仍然**未核实**。 |
| **D** | 官方文档、README、项目页或论文明确陈述；相应代码实现**未核实**。README 中的接口示例仍按 D 处理。 |
| **U** | **未核实**；没有充分的一手证据，或没有检查到足够实现。不能作为已具备能力。 |
| **P** | 本报告的设计建议、分析或推论；不是外部项目或 Orbit 的现状声明。 |

表格中的 C/D 标记作用于该单元格或该条事实；同一行的分类结论属于 P。外部引用均为官方来源；未将搜索摘要中的第三方转载当作实现证据。GitHub 链接主要指向访问时的 `main`/`master`，不是永久版本快照；正式集成必须另行固定 commit、数据 revision、镜像 digest 和 scorer 版本。本文查阅的本地 Orbit HEAD 为 `b52345c980d7d6b647308613c5f94dc539a04705`，本地路径和行号只对应此次查阅状态。

## 1. 哪些分类轴真正决定集成

以下“优先级”是 P；例证及其证据等级单独列出。

| 分类轴 | 实际取值与一手例证 | 对集成的预测力 |
|---|---|---|
| **被评测对象与边界** | model completion/likelihood（C，[lm-eval][lm-model]）；可执行 agent 提交 patch/产物（D，[HAL agent][hal-agent]）；固定 policy server 根据 observation 返回 action（D，[VLA][vla-arch]）；可使用工具的会话 agent 与模拟用户（D，[τ²][tau2-paper]）。 | **最高**。决定 Orbit 启动谁、谁持有状态、谁能调用工具、哪些计算计入被测方法，以及交付物是什么。模型品牌或 CLI 进程名不能替代此轴。 |
| **交互控制权与时序** | single-shot、固定历史的 multi-turn 请求；环境反馈驱动的 tool loop；闭环 `reset/step`；工作区中写代码并提交；用户与 agent 双方改变共享环境；多玩家轮转。C/D 例证分别见 [simple-evals][simple-types]、[OpenEnv][openenv-core]、[τ²][tau2-paper]、[TextArena][textarena]。 | **最高**。决定一次 trial 是一个请求、一个 solve session、一个 episode，还是一个 match；决定停止、同步、重置和事件关联规则。 |
| **环境与可重置性** | 无交互环境、sandbox workspace、自托管 web、live web、desktop VM、mobile emulator、simulator、real robot。D：[Harbor][harbor-task]、[WebArena][webarena]、[Online-Mind2Web][online-mind2web]、[OSWorld][osworld]、[AndroidWorld][android]、[RoboArena][roboarena-paper]。 | **很高，适合子 profile**。影响资源、快照、账户、外部状态、设备独占和复现；同一 GUI 动作族的浏览器与桌面仍需不同生命周期。 |
| **评分来源** | 归一化答案匹配（C，[GAIA scorer][gaia-scorer]）；测试/执行结果（D，[SWE-bench][swe]）；状态检查/环境 reward（C，[BrowserGym][bg-task]、[AndroidWorld][android-task]）；LLM judge（D，[PaperBench][paperbench]）；人工成对偏好（D，[RoboArena][roboarena-paper]）。 | 高，但应作为独立 scorer profile。相同 GUI 契约可搭配状态 scorer 或视觉 judge；相同 LLM judge 也可评文本、研究代码或网页轨迹。 |
| **online/offline** | 固定数据集上的请求；在线执行但环境冻结；真实外部网站/服务；先采集轨迹后离线重评分。D：[lm-eval][lmeh]、[WebArena][webarena]、[MCP-Universe][mcp-universe]、[Online-Mind2Web][online-mind2web]。 | 不能只用一个布尔值。建议分成 `interaction=offline/online`、`world=frozen/live`、`grading=inline/posthoc`。联网调用模型并不自动成为 live-world benchmark。 |
| **领域、能力、模态** | HAL 按 Web Assistance、Scientific Programming、Software Engineering、Customer Service 等展示；HELM 扩展到 safety、vision、image、audio；BFCL 按函数调用类型和轮次分组（D，[HAL][hal-site]、[HELM][helm]、[BFCL][bfcl-categories]）。 | 适合检索、分层统计和 UI 标签；单独使用时预测力不足。“robotics”不能区分编码 agent 与原生 policy；“multimodal”不能区分图像问答与桌面操作。 |

**P：最有效的分解是“交互契约决定大类，环境决定子 profile，评分和风险决定附加 profile”。** `reset/step` 只是一个可复用的形状：浏览器点击、机械臂连续控制和多人游戏虽都可写成 step，却不共享动作语义、实时性、参与者或评分证据。因此既不应按每个领域建立独立平台，也不应把所有任务压成一个无类型的 `episode`。[Gymnasium][gym]（D）、[BrowserGym task][bg-task]（C）、[VLA 架构][vla-arch]（D）、[TextArena][textarena]（D）构成这一推论的依据。

## 2. 通用框架如何组织 benchmark 与接口

| 框架 | 实际组织方式与接口 | 对 Orbit 的含义（P） |
|---|---|---|
| **Harbor / Terminal-Bench registry** | D：Harbor task 用 instruction、task 配置、环境定义、可选 reference solution 和 verifier；verifier 输出 reward 文件。Terminal-Bench registry 按 benchmark 发布，并通过 adapter 纳入不同来源的任务；官方 registry 文章讨论 native/adapted 结果的一致性检查。[任务格式][harbor-task]、[registry 与 adapters][tb-registry] | Harbor 是工作区/环境任务的交付协议，registry 是发现与分发层；它们不是“所有 benchmark 都是 coding”或“所有类别都须经过 hub”的证据。可复用格式与 parity 方法，保留原 benchmark 身份。 |
| **UK AISI Inspect / inspect_evals** | D：`Task` 组合 dataset、solver、scorer，支持 sandbox；agent 可作为 solver、tool 或通过 bridge 接入，也支持多个 agent。sandbox 提供执行工具所需的隔离环境。inspect_evals 当前目录区分库内与 external registrations，列出 AgentDojo/AgentHarm、BFCL、GAIA、PaperBench 等不同能力和风险任务；不是按固定环境接口分成少数类。[Task][inspect-tasks]、[agents][inspect-agents]、[sandbox][inspect-sandbox]、[evals catalog][inspect-evals] | 值得借鉴“任务编排、被测 solver、环境、评分分别组合”。同一个框架能覆盖多类，不能把 Inspect 本身作为 Orbit 的一个语义大类。 |
| **HAL — Holistic Agent Leaderboard** | D：面向多个 agent 应用领域，同时关注能力和成本；harness 使用通用 agent 入口，但 task 内容与 submission 仍按 benchmark 区分。例如 SWE 提交 patch，AppWorld 修改环境后返回完成标记，编程题返回代码。[HAL][hal-site]、[harness][hal]、[agent 接入说明][hal-agent] | 一个通用 Python `run(input, **kwargs)` 外壳并没有消除 benchmark 的真实接口差异。模型、scaffold、工具、预算应共同组成被测方法身份。 |
| **OpenAI evals（开源仓库）** | D：基础和 model-graded eval 模板、注册数据及自定义 completion function。C：`CompletionFn.__call__` 接收文本或聊天 prompt，返回可提取文本 completions 的结果。[README][openai-evals]、[`evals/api.py`][evals-api] | 适合固定请求与自定义评测程序；completion function 可以封装 agent，但封装后的环境、生命周期和轨迹仍须显式声明。本行讨论开源仓库，不将其等同于托管 Evals API。 |
| **OpenAI simple-evals** | C：`SamplerBase(MessageList) -> SamplerResponse`，`Eval(sampler) -> EvalResult`；结果含主分、其他指标、conversation/HTML/metadata。D：仓库提供一组具体 benchmark 的参考实现。[类型实现][simple-types]、[README][simple-readme] | 是轻量 request/scorer 模式的参照，不宜据此推定通用 agent sandbox、实时控制或用户模拟接口已经统一。 |
| **HELM、HELM Safety 与多模态变体** | D：HELM 以 scenario、adapter、model request、metric 组织评测；README 列出 safety、vision/image、audio 等系列。C：`Adapter.adapt()` 把 `Instance` 列表变成 `RequestState` 列表。D：HELM Safety 组织多个安全数据集及风险维度。[README][helm]、[Adapter 代码][helm-adapter]、[Safety 官方说明][helm-safety] | “安全、视觉、领域”主要是评测切片，不能直接当环境协议。**U：未核实**存在一个可确认的、独立官方命名的 “HELM Agent” 通用交互变体；不能把 Princeton 的 HAL 当成 Stanford HELM 的 agent 版。 |
| **lm-evaluation-harness** | D：按 task/config、task group、模型 backend 组织；C：模型核心操作包括 `loglikelihood`、`loglikelihood_rolling`、`generate_until`。[README][lmeh]、[`LM` 代码][lm-model] | “答题”内部也有硬能力差异：只提供最终文本的 CLI agent 不自然具备 token likelihood。C1 必须区分 generation 与 likelihood 能力，不能伪造 logits。 |
| **AgentBench** | D：原始版本按 8 个环境展示：OS、Database、Knowledge Graph、Digital Card Game、Lateral Thinking Puzzles、House-Holding（ALFWorld）、Web Shopping（WebShop）、Web Browsing（Mind2Web）。README 同时记录后续 FC/AgentRL 路径，目前列出的容器化支持子集不是原始全部 8 环境。[官方 README][agentbench] | 这是“具体环境集合”，不是 8 个基础设施大类。Database/KG 可归工具工作流，OS 可归工作区，卡牌可归游戏；须保留版本及实际动作接口，不能仅从环境名字推定分类。 |
| **Meta 发起的 OpenEnv** | D：当前官方仓库为 `openenv/OpenEnv`，把环境服务、客户端和隔离部署组合起来，包含多种环境。C：`Environment` 定义 typed `Action`/`Observation`/`State`，以及 `reset`、`step`、`state`、`close`，另有 async 路径。[README][openenv]、[接口代码][openenv-core] | 可复用环境服务模式，但 typed schema 由各环境决定。它是环境层标准，不替代 benchmark task、scorer、被测 agent 和聚合规则。 |
| **Gymnasium** | D：`reset` 返回 observation/info；`step` 返回 observation、reward、`terminated`、`truncated`、info；定义 action/observation spaces。[官方 Env API][gym] | 值得保留 terminated 与 truncated 的区别；两者都不能直接映射为 Orbit invalid。Gym 风格不自动解决多玩家调度、真实设备控制或安全边界。 |

**版本提示（D/U）。** simple-evals README 声明不再持续更新新模型成绩，HELM README 标注维护状态，HAL harness README 也有 leaderboard 状态说明；这些仓库仍可作为接口证据，但本文不将它们描述为持续同步的“最新能力总榜”。具体项目的活跃维护范围与未来计划**未核实**。[simple-evals][simple-readme]、[HELM][helm]、[HAL harness][hal]

**D：HELM 的分类还明确把 scenario 与 desiderata/metric 分开。** 原始论文的多指标维度包括 accuracy、calibration、robustness、fairness、bias、toxicity、efficiency。这是不要把“评分目标”直接等同于“接入接口”的一手先例；论文中的历史场景规模不代表当前 registry。[HELM 论文][helm-paper]

## 3. 专门生态：按真实接口比较

### 3.1 工具、函数调用、用户协同与 MCP

| 项目 | 被测对象、交互与评分证据 | 建议归类 |
|---|---|---|
| **τ-bench** | D：服务 agent 依据领域 policy，调用工具并与 LLM 模拟用户对话，领域包括 retail、airline。C：runner 保留 reward 与消息轨迹；`agent.solve` 的捕获异常分支写入 reward 0 和 error；metrics 实现 `pass^k`。[README][tau]、[`run.py`][tau-run] | C4 模拟用户服务会话。用户 simulator 是独立角色与实验配置，不是 task 的一个静态字符串。 |
| **τ²-bench / 当前 tau2-bench 仓库** | D：原始 τ² 论文的 telecom 是 dual-control：agent 与用户都能用工具改变共享环境，用户行为受状态和工具约束。当前仓库已扩展到文字、full-duplex voice 等版本，不能把当前默认配置当作 2025 论文协议。[τ² 论文][tau2-paper]、[当前 README][tau2] | C4；子 profile 区分 single/dual control、half/full duplex、text/voice、用户模型与语言版本。 |
| **BFCL** | D：分类明确包含 single-turn、multi-turn、agentic、memory、web-search、live/non-live；README 区分 AST/执行评估及不同代际任务。这里 `live` 明确表示用户贡献题目，**不等于 live-web**。[README][bfcl]、[分类文档][bfcl-categories] | 静态生成函数调用且不把执行结果反馈给模型：C1；实际执行并根据返回继续决策：C3。工具 schema 和 AST 评分不能替代有状态环境的最终状态检查。 |
| **MCP-Universe** | D：连接真实 MCP 服务，跨搜索、位置、浏览器、金融、仓库等领域；任务可依赖动态、时间敏感的外部信息，提供运行轨迹/可视化。[官方 README][mcp-universe] | 通常 C3 + live-service；如果某 benchmark profile 强制 GUI 动作并按 GUI 过程评测，则为 C5。MCP 是工具传输/发现协议，不是一种评分语义。 |
| **MCPMark** | D：面向 Notion、GitHub、文件系统、Postgres、Playwright 等任务，强调状态准备、自动验证与多次运行指标；有不同数据/verified 版本。[官方 README][mcpmark] | 大多 C3 + stateful tools；Playwright 场景需按开放的实际接口判定 C3/C5。不能因为同一服务器品牌而共享 reset 和验证规则。 |
| **MCP-Bench（Accenture）** | D：考察跨 MCP 服务器的工具发现、选择和调用；评测组合规则检查与 LLM 评估维度，并提供单/多服务器配置。[官方 README][mcpbench] | C3。必须固定 server 集、schema、外部账户状态和 judge 配置。本报告特指 Accenture 仓库，同名其他项目的协议**未核实**。 |
| **GAIA** | D：问题可带附件，难度等级反映工具与自主性需求；面向可搜索、可使用工具的助手。C：官方 scorer 对数值、列表、文本采用不同归一化后比较，并非逐字节统一 exact match。[数据卡][gaia]、[scorer][gaia-scorer] | 标准工具助手 profile 为 C3；限定浏览器的实验可标 C5；固定材料无工具的消融属于不同 C1 profile。最终答案短，不代表求解接口 single-shot。 |

**P：C3 与 C4 应拆开。** 普通工具任务中的后续消息可以是确定的任务脚本；C4 的用户具有隐藏目标/信息、可变回应，甚至拥有改变环境的行动权。此时 scorer 必须辨认用户角色、双方动作和共享状态，资源账本也多一个用户模型。τ² 的 dual-control 设计直接说明了这个差异。[τ² 论文][tau2-paper]（D）

### 3.2 浏览器、桌面与移动设备

| 项目 | 接口、环境与评分/记录证据 | 建议归类 |
|---|---|---|
| **BrowserGym** | D：统一接入 MiniWoB、WebArena/VisualWebArena、WorkArena 等，同时列表中也有离线数据型任务。C：`AbstractBrowserTask` 有 `setup(page)`、`validate(page, chat_messages)`、`teardown()`，validate 返回 reward/done/message/info。[README][browsergym]、[task.py][bg-task] | 在线浏览器任务 C5/browser；不能凭 BrowserGym 包名把其所有任务都视作在线 GUI。它是可复用环境库，MiniWoB/WebArena 仍是具体 benchmark。 |
| **Cua / cua-bench** | D：Cua 提供 computer-use 工具；cua-bench 以 setup、agent、evaluate 组织任务，支持不同 sandbox/OS 运行方式，并输出 result、日志和 ATIF 轨迹。文档区分 fresh sandbox 的多次 attempts 与评测开始前的启动/连接 retries。[Cua][cua]、[cua-bench][cua-bench] | C5/desktop 或 browser；操作系统、container/VM、显示分辨率和允许工具是子 profile。不能把启动重试当额外 pass@k 尝试。 |
| **CUA-Lite** | C：`LiteBaseEnv` 提供 async `reset() -> LiteEnvObservation`、`step(actions: list[RuntimeEnvAction]) -> LiteEnvStepResult`、`close()`，存在 tool schema 与动作封装边界。[`lite/gym/base.py`][cualite-base] | 是跨 GUI backend 的接口范例。具体 action 字段、坐标、采样策略及全部 benchmark 的等价性**未核实**；不在规范中凭名称假设统一像素坐标或统一 grader。 |
| **WebArena / VisualWebArena** | D：WebArena 提供自托管网站环境与 browser action 执行；VisualWebArena 在这一可复现执行设置上增加视觉任务，并发布 HTML 轨迹和部分 Playwright traces。[WebArena][webarena]、[VisualWebArena][visualwebarena] | C5/browser-self-hosted；网站数据库、cookie、账户、初始状态与浏览器均属于 reset 边界。视觉输入是模态 profile，不另建顶层类。 |
| **WebVoyager / Online-Mind2Web** | D：针对真实网站；WebVoyager 提供基于截图的自动与人工评估；Online-Mind2Web 的记录包括逐步截图和动作等信息，并用 WebJudge/人工评估，仓库记录失效任务及评估版本变更。[WebVoyager][webvoyager]、[Online-Mind2Web][online-mind2web] | C5/browser-live。域名、执行日期、登录态、页面漂移、验证码与 judge 版本影响可比性；无法承诺像冻结站点一样任意 reset/replay。 |
| **OSWorld** | D：桌面环境经 VM/虚拟化 provider 执行任务，提供观察、动作和任务 evaluator，当前 README 涉及 Verified 更新。[官方 README][osworld] | C5/desktop-VM。VM image、snapshot、OS/app 版本、显示与 provider 是身份和资源配置。**U：未核实**所有异常是否均按 0 分计入官方结果，不从其他 harness 类推。 |
| **AndroidWorld** | D：Android emulator 与可参数化应用任务。C：`TaskEval` 的初始化/清理操作用于任务环境准备与恢复，`is_successful()` 可以返回组合任务的部分成功值。[README][android]、[`task_eval.py`][android-task] | C5/mobile-emulator。需要 emulator readiness、应用状态重置与参数 seed；不能统一假设每个 GUI scorer 都只返回二值成功。 |

### 3.3 具身 policy、真实机器人与 EFE

| 项目 | 契约与实际组织方式 | 对分类的含义 |
|---|---|---|
| **vla-evaluation-harness（AllenAI）** | D：把 model/policy server 与 benchmark 环境分开，支持不同运行/时序模式；WebSocket/msgpack 传输 observation/action，提供 episode handshake、同步/实时等运行配置。C：`DimSpec` 检查维度、格式、范围兼容性；collector 聚合 benchmark 自定义 metric。[README][vla]、[架构][vla-arch]、[specs.py][vla-specs]、[collector.py][vla-collector] | C6 的接口参考。server 协议可共享，benchmark 身份仍应直接是 LIBERO 等；动作含义、单位、图像约定、控制频率必须另行声明。 |
| **LeRobot** | D：robot 的连接、观测、发送动作与 policy 的动作选择分开；LeRobotDataset v3 用表格状态/动作、视频及 metadata 组织机器人数据。[README][lerobot]、[Dataset v3][lerobot-data] | C6 的设备/数据接口参考；Dataset 是记录格式，不是全部机器人通用的在线 step 协议或统一 success scorer。 |
| **LIBERO 原生** | D：按任务与 task suite 组织，包含语言、初始状态及模拟器控制；示例展示 reset、初态设置和环境 step。[官方 README][libero] | C6/native-policy；与编码 agent 现场生成控制程序的 EFE profile 不同。 |
| **SimplerEnv** | D：面向机器人 policy 的模拟评测，区分 Visual Matching 与 Variant Aggregation：前者匹配现实视觉条件，后者跨变化条件汇总。[官方 README][simpler] | C6/simulator；real-to-sim 对齐不等于在真实机器人上执行。应保留变化组与初态分层，不能只报一个未经说明的 episode 池均值。 |
| **Isaac Lab Arena** | D：组合 task/scene/embodiment/environment，提供 policy 与实验运行接口以及评测/鲁棒性能力；具体资源和运行方式依配置。[官方文档][isaac-arena] | 通常 C6。不要把产品名字、GPU 仿真引擎或某个示例 GPU 数写成顶层类别或所有任务的硬要求；精确资源需求须逐 benchmark 校准。 |
| **RoboArena** | D：真实机器人上的分布式 policy 评估；同一比较中的两个 policy 使用匹配的任务与环境，以双盲成对反馈汇总排名；项目提供远端 policy server 接入。[论文][roboarena-paper]、[官方项目页][roboarena] | C6/real-robot + human-pairwise scorer。不是仿真 benchmark，也不能与名字相近的其他 RobotArena 项目混用。人类 evaluator 不等于环境中的对手 agent。 |
| **Embodied First Exam** | D：被测对象是编码 agent，编写并执行控制代码。当前协议区分 privileged、standard、standard-realtime：privileged 可交 trajectory/code 后重放；standard 使用不可进入的 simulator sidecar，按 live episode 评分；realtime 另有持续时钟。并非所有模式都是同一种“提交后 grader 重放”。[README][efe]、[协议 §3/§4][efe-protocol] | 按本任务关注的编码-agent profile 归 C2，并带 simulator-control 子 profile；其内部使用闭环控制不把被测对象变成固定 native policy。若另设固定 policy 的实验，必须另命名 C6 profile，不能沿用 EFE coding 成绩。 |

**P：EFE 边界应以“谁被评测”来定。** 如果 trial 启动一个编码 agent，给它文档/API、编辑执行能力与解决时间，评的是现场编写/调试控制方案的整个系统，就是 C2；如果 trial 装载一个已固定的 policy，按指定 observation/action schema 重复调用推理接口，评的是其闭环行为，就是 C6。二者都可能产生机械臂轨迹，也都可能用相同 upstream success predicate，但解题权限、计算预算、观测权限、reset 次数和被测方法完全不同。[EFE 协议][efe-protocol]、[LIBERO][libero]、[VLA 架构][vla-arch]（D）

**D/U：EFE 的“约 35 suites”是聚合规模，不是 35 个接口大类。** Orbit catalog 明确列了 35 suites；外部 EFE README 也列出不同来源及自有套件。但本报告没有逐一审计 35 套件的源码、与 upstream 任务的逐题对应或评分一致性，这些均为**未核实**；不能将 EFE 的 LIBERO/MetaWorld 等结果重新命名为原生 policy benchmark 成绩。[Orbit catalog:9](orbit/docs/catalog.md:9)、[EFE README][efe]

### 3.4 游戏、多主体、研究与软件工程

| 项目 | 接口、环境与评分证据 | 建议归类 |
|---|---|---|
| **TextArena** | D：覆盖 single/two/multi-player、competitive/cooperative；示例用 `reset(num_players)`、`get_observation()` 取得 player id 和文本 observation，agent 返回文本动作，环境 step，最终返回按玩家区分的 rewards。[官方 README][textarena] | C7。回合顺序、角色可见信息、对手身份和每玩家 reward 是核心契约。 |
| **BALROG** | D：评估 LLM/VLM 在多种长时程 RL 游戏环境中的交互能力，采用环境内行动与反馈，而非仅回答游戏知识题。[官方 README][balrog] | C7/single-player 也成立；无需为了命名“多主体”把单玩家游戏硬塞进静态问答。具体各游戏 action schema 与错误分母**未核实**。 |
| **MLE-bench** | D：让 agent 完成机器学习竞赛任务，使用重新划分的数据与本地 grading，交付预测文件；提供分竞赛结果及相应汇总配置。[官方 README][mle] | C2/research-training。数据隔离、训练资源、提交格式和隐藏 test 是重点；不是普通最终答案 matching，也不是训练出来的模型直接成为本轮被测 subject。 |
| **PaperBench** | D：由 agent 构建论文复现代码；full pipeline 分为 Agent、在新 GPU 环境运行 Reproduction、Grading。Code-Dev 变体跳过部分执行/结果验证，不能与 full 等同。[官方 README][paperbench] | C2/research-reproduction；需要至少三个阶段的产物传递与证据连接，judge 看到的证据必须来自相应 reproduction。 |
| **RE-Bench** | D：使用 METR Task Standard 组织 AI R&D 任务，比较 agent 与人类表现；不同任务有不同实数或任务相关评分。[官方 README][rebench] | C2/research-R&D。保留任务尺度、预算与原始评分，不能因同属 research 而对所有题强行二值化。 |
| **SWE-bench family** | D：从 repository/issue 产生 patch，通过环境中的测试评估；Full/Lite/Verified、Multimodal、Multilingual 等版本改变任务集合或输入，但不意味着都变成 GUI 操作。[官方 README][swe] | C2/repository-patch。数据集版本、repo commit、测试环境与 patch 是主要身份。仅收到固定题目并输出代码的 completion benchmark 则可为 C1，是否跑测试不是唯一分类条件。 |
| **AgentDojo / 安全评测** | D：AgentDojo 在工具任务中引入 prompt-injection attack 与防御；HELM Safety 从不同风险场景组织模型评估。[AgentDojo][agentdojo]、[HELM Safety][helm-safety] | safety/red-team 是跨类别的 threat-model profile：可叠加在 C1、C3、C5 等接口之上。攻击者角色、注入位置、攻击预算及 benign utility 需单独记录。 |
| **人类偏好 arena** | D：Chatbot Arena 以真实用户的成对偏好比较模型；RoboArena 以真实机器人 policy 的成对评估组织排名。[Chatbot Arena 论文][chatbot-arena]、[RoboArena 论文][roboarena-paper] | preference-arena 是采集/评分/聚合 profile，不应与 C7 的“环境中两 agent 对抗”混为一类。被比较的输出/轨迹仍属于 C1/C4/C6 等对应接口。 |

## 4. 推荐的 7 类及明确的成员规则

本节全部是 **P：建议**；示例事实来自第 2–3 节所引来源。顶层分类回答“要把一个被测系统接进来，必须实现哪一套交互契约”，子 profile 承担资源、环境与 scorer 的细节。

| 类别 | 纳入规则：本轮到底评什么 | 排除/分界 | 典型例子与子 profile |
|---|---|---|---|
| **C1 固定输入响应** | 向被测模型提交固定输入或固定历史，请求输出/候选概率；没有根据该输出演化并返回给模型的外部可变任务环境。 | 已给定多轮历史仍可属于 C1；真实工具执行结果进入后续决策则转 C3。仅执行生成代码来评分，不自动转 C2。 | lm-eval、simple-evals、静态 BFCL；generation、likelihood、multimodal QA、speech offline、固定代码生成。[lm-model]、[simple-types]、[bfcl] |
| **C2 工作区与产物** | 被测系统获准在工作区编辑、运行、训练、调试；或提交一个需独立部署/执行的工程产物（含入口、依赖、资源和环境契约），供 reproduction、控制或业务执行。产物及执行过程是评测对象。 | 固定 prompt→函数源码→无反馈单元测试的纯 completion profile 留 C1；固定 policy 的推理测评属于 C6；强制 GUI 动作的 CLI agent 属 C5；工具调用外包一层 Python 不自动成为 C2。 | SWE-bench、Terminal-Bench、MLE-bench、PaperBench、RE-Bench、EFE coding；patch、terminal、code-submission、research、simulator-program。[swe]、[harbor-task]、[paperbench]、[efe-protocol] |
| **C3 工具/API 工作流** | 被测 agent 自主选择语义工具，消费返回结果，修改/查询应用状态，最终回答或完成业务目标；无作为核心任务角色的可变用户协同者。 | 静态函数调用输出为 C1；独立模拟用户参与协同为 C4；强制 GUI observation/action 为 C5。 | GAIA 工具 profile、MCPMark、MCP-Universe、BFCL 执行循环；local-state、remote-service、search、memory。[gaia]、[mcpmark]、[mcp-universe]、[bfcl-categories] |
| **C4 模拟用户服务会话** | 被测 agent 与独立用户角色持续交流，用户掌握任务信息/目标，可根据对话或状态行动；服务任务成功依赖这种协同。 | 固定 transcript 的补全为 C1；固定消息脚本驱动的工具测试可留 C3；胜负依赖博弈策略的参与者为 C7。 | τ-bench、τ²；single/dual control、text/voice、half/full duplex。[tau]、[tau2-paper]、[tau2] |
| **C5 GUI 交互** | 被测系统通过声明的 screenshot/DOM/accessibility/UI observation 和 GUI/browser actions 操作应用完成任务。 | 离线 screenshot grounding/下一步预测为 C1；任意后门 API 直接改目标状态不属于原 GUI profile。工具传输使用 MCP 不改变这一点。 | MiniWoB、WebArena、VisualWebArena、WebVoyager、Online-Mind2Web、OSWorld、AndroidWorld；browser-self-hosted、browser-live、desktop-VM、mobile-emulator。[browsergym]、[webarena]、[osworld]、[android] |
| **C6 具身闭环控制** | 在固定 policy/agent 接口下，按物理世界或模拟器观测产生具有机器人/物理含义的动作；重置、时序和控制映射属于测试协议。 | 现场生成和调试控制程序的编码-agent 实验为 C2；静态机器人视频问答为 C1。一个 VLM 也能属于 C6，模型名称不是限定条件。 | 原生 LIBERO、SimplerEnv、Isaac Lab Arena、RoboArena；sim、real-device、synchronous、real-time、action-chunk。[libero]、[simpler]、[isaac-arena]、[roboarena] |
| **C7 游戏与多主体环境** | agent 在规则定义的 episode/match 中采取动作；核心契约包含游戏进展、角色、轮次、对手/协作者或按玩家返回的效用。允许单玩家。 | 模拟用户服务会话按 C4；人工比较两个答案的 arena 是 scorer profile；物理机器人比赛可用 C6 主类 + match profile，而不是抹掉物理控制要求。 | TextArena、BALROG、AgentBench Digital Card Game；single-agent、turn-based、simultaneous、cooperative、competitive。[textarena]、[balrog]、[agentbench] |

**P：混合任务的裁决顺序。** 先固定被测系统、允许的能力和原始 benchmark 协议，再检查最强约束：物理动作/实时控制→C6；强制 GUI→C5；工作区求解与程序/产物交付→C2；用户协同→C4；游戏/多主体规则→C7；一般工具反馈→C3；其余固定请求→C1。这个顺序适用于确定实际 profile 后的裁决，不能跳过被测边界。例如 EFE 标准模式虽然内部有物理控制，外层被测系统仍是现场求解的编码 agent，所以选 C2，并强制挂载 simulator-control profile。若任务实质组合了不可省略的契约，声明一个主类和必需 profiles，不能悄悄放宽原任务。

**P：三类容易误分的情况。**

1. **模型、agent scaffold 与环境库不是同一层。** 同一模型可参加 C1/C3/C5/C6；同一 CLI 可以执行工作区或 GUI agent；同一 BrowserGym/OpenEnv 可承载不同 benchmark。分类对象必须是完整 evaluation profile。
2. **“是否返回文字”“是否使用工具”都不够。** GAIA 最终返回答案，但过程可有工具循环；工作区、GUI 与机器人控制也都可经工具调用实现。应看允许的操作和状态变化语义。
3. **“有 simulator”不意味着机器人，“有 arena”不意味着对抗 agent。** 游戏 simulator、物理控制 simulator 和成对人工评分在生命周期与聚合上有不同要求。必要时复用底层 env client，仍保留语义差异。

## 5. 每类只保留五组真正不同的集成点

以下均为 **P：可执行规范建议，尚未实现/验证**。五组是：①被测端输入输出；②生命周期与资源；③评分和有效性证据；④轨迹与 review；⑤校准。通用日志、lease、重试、存储、UI 与结果索引不重复实现。

### C1 固定输入响应

1. **输入输出：**声明 `generate / score_candidates / loglikelihood` 能力；输入是带 id、split、模态引用的样本，输出是原始响应与解析后答案。固定历史的 multi-turn、固定音视频、工具调用 AST 都是 profile；必须固定 prompt/chat template、tokenization、解析和 normalization。
2. **生命周期/资源：**加载数据与模型 endpoint，批量请求；通常无每题可变 workspace。模型启动、batch/concurrency、GPU/内存、API 配额与 judge 成本分开登记；静态音视频需声明采样率、帧抽取和转码，不隐式改变输入。
3. **评分/有效性：**接上 exact/normalized match、AST、执行测试或 judge。模型正常生成错误格式可为有效失败；请求从未成功、输入解码损坏、scorer 不可用不能冒充错误答案。缺输出究竟按官方 fail 还是 exclude 必须明示。
4. **轨迹/review：**最小记录为输入资产 hash、实际请求、完整响应、解析结果、参考答案/隐藏答案引用、每个 scorer 输出及理由。UI 展示逐题对照；无需伪造环境 step。
5. **校准：**已知答案/错误答案、解析边界、数字/列表/空答案、模态预处理、likelihood 数值核对；与原始 runner 在相同样本与参数上对齐。不能要求随机猜测或 empty 在所有题都为 0。

依据：C 的 [lm-eval 模型接口][lm-model]、[simple-evals 类型][simple-types]、[GAIA normalization][gaia-scorer]及 D 的 [BFCL 分类][bfcl-categories]。

### C2 工作区与产物

1. **输入输出：**输入 task、repo/data snapshot、文档/API、允许工具及预算；输出 patch、目录、代码、prediction CSV、模型文件或可审查报告。明确“agent 生成的控制程序”属于产物，以及哪些 live 调试事件也是被评分对象。
2. **生命周期/资源：**`prepare → solve → freeze/export → reproduce(optional) → verify → collect/cleanup`；agent、训练任务、模拟器、reproduction 与 grader 按角色分配资源。长任务需要声明磁盘、GPU 类型/显存、时间、数据挂载和网络，不以单个 agent 容器预算覆盖所有服务。
3. **评分/有效性：**由可信测试、隐藏数据、模拟器 sidecar 或独立 reproduction/judge 产生证据；隔离 agent 可改写区域与 scorer/reference。代码错误、测试失败、无有效提交可能是有效失败；环境未准备、实例不匹配、grader 崩溃须单独报告。EFE 的模式与错误归属按其协议，不能统一按“sim error=infra”。
4. **轨迹/review：**保留对话/工具过程、文件 diff、最终产物 hash、测试日志、reproduction 环境/结果、rubric 叶节点；EFE 还需模拟器动作与视频及其来源。ATIF 可作 agent 层索引，不能取代执行产物和 simulator 记录。
5. **校准：**reference patch/program、故意坏提交、缺提交、恢复初态和评分隔离；研究类要验证真正的 reproduction 而非仅看代码；EFE privileged 与 standard 分开测。最后用至少一个真实被测方法与原 runner 对齐，不能把 oracle 通过当模型成绩一致。

依据：D 的 [Harbor][harbor-task]、[SWE-bench][swe]、[MLE-bench][mle]、[PaperBench][paperbench]、[EFE 协议][efe-protocol]。

### C3 工具/API 工作流

1. **输入输出：**声明任务、tool schema、可见状态、持久 memory 权限；接收工具名/参数及最终答复，返回结构化结果/错误。固定 tool set、schema version 和工具发现机制；MCP 仅作为可选 transport。
2. **生命周期/资源：**每 trial 准备隔离 namespace、账户/数据库 fixture；连接 local/remote servers，验证 readiness，执行循环，收集最终状态并 reset。资源包括服务 CPU/内存、模型与工具 API 配额、rate limit、网络和超时；live-service 要记录日期与外部状态证据。
3. **评分/有效性：**按最终业务状态、指定动作约束、答案或 judge 评分；工具调用成功不等于任务成功。错误参数若属于 agent 选择应作为任务行为保留；服务 503、认证/fixture 故障与模型犯错分别映射，不能“凡 tool error 一律 invalid”。
4. **轨迹/review：**记录工具发现结果、schema、call id、参数、返回、重试/副作用、前后状态 diff、最终答复；支持从状态验证结果回链到调用。跨服务器 trace 需要共享 trial id，而非仅保存最终文本。
5. **校准：**已知正确调用序列、irrelevant/missing tool、schema 错误、重复提交、部分副作用、外部失败；对 live data 用执行当时的证据核对，缓存/录制替代实时服务时须成为不同 profile。

依据：D 的 [BFCL][bfcl]、[MCP-Universe][mcp-universe]、[MCPMark][mcpmark]、[MCP-Bench][mcpbench]。

### C4 模拟用户服务会话

1. **输入输出：**分别声明 agent 与 user 的可见指令、隐藏目标、policy 和 tools；消息有角色、说话顺序及结束信号。dual-control 要包含 user actions；voice profile 定义音频流、采样率、打断、静音和 full-duplex 时序。
2. **生命周期/资源：**初始化共享业务状态、agent、user simulator、通信通道；终止和重置双方 memory。user model 与被测 model 分别计费/限额；语音流有连接、实时延迟和并发资源，不能用文本 token budget 代替所有预算。
3. **评分/有效性：**检查事务状态、任务约束、沟通要求；用户 simulator 失效、偏离约束、断流与 agent 的错误决策分开标注。模拟用户顺从不等于成功；用户帮忙直接完成任务也需按照原 benchmark 规则解释。
4. **轨迹/review：**保存双方消息/工具、共享状态、结束原因；语音保留音频、时间对齐 transcript、打断和重叠说话事件。明确 transcript 是原始数据还是模型转写；review 能定位哪一方造成状态变化。
5. **校准：**固定用户模型/提示词/seed 和领域 policy；测试协同成功、合理拒绝、用户约束违背、双向状态改变与异常退出。报告跨用户随机性的重复试验，区分 `pass^k` 的可靠性与 best-of-k 能力。

依据：D 的 [τ-bench][tau]、[τ² 论文][tau2-paper]、[当前文字/语音文档][tau2]；C 的 [τ-bench runner/metrics][tau-run]。

### C5 GUI 交互

1. **输入输出：**声明 screenshot/DOM/accessibility tree 的组合、viewport、坐标系、允许 action set（mouse/keyboard/browser/mobile）；输入 observation，输出动作与可选 final answer。DOM 特权和直接 backend API 访问必须在 profile 中明示。
2. **生命周期/资源：**browser、desktop VM、mobile emulator 分别有 readiness、初态恢复和应用 reset；live web 记录不可重置项。资源包括 display、虚拟化/KVM 条件、CPU/RAM、浏览器进程、存储、网络/账户；episode 结束后确认实例清理。
3. **评分/有效性：**优先保留 benchmark 自带 state evaluator；视觉/语言 judge 是另一来源。记录终态、页面/app 可用性、task 参数与停止原因；点击错误/走错页面是任务失败，快照无法恢复是环境失败，验证码如何计分由原 profile 声明。
4. **轨迹/review：**截图与动作一一关联，保留 action 前后 observation、时间、URL/app/window、reward 和终止字段；可链接 DOM/accessibility、视频和 native trace。视频可观看不等于可执行重放；敏感信息处理应保留足够审查证据及 redaction 标记。
5. **校准：**脚本化成功/失败路径、坐标映射、键盘输入、浏览器/VM reset、终态 evaluator；live web 另测网页可达性和 judge 与人工一致性。只跑 empty 无法验证真实模型接收截图和发出动作的全链路。

依据：C 的 [BrowserGym task][bg-task]、[trace 写入][bg-loop]、[CUA-Lite base][cualite-base]、[Android task][android-task]；D 的 [Cua Bench][cua-bench]、[WebArena][webarena]、[Online-Mind2Web][online-mind2web]、[OSWorld][osworld]。

### C6 具身闭环控制

1. **输入输出：**固定 camera 顺序/分辨率、proprioception、任务语言、action 维度/单位/坐标系、夹爪约定、控制频率与 action chunk；明确 policy 初始化/episode reset/推理协议。policy weights、预处理、normalization 和控制器也是方法身份。
2. **生命周期/资源：**policy server 与 simulator/设备分别启动和检查 readiness；固定 initial-state id 与 seed，运行 episode，保存终态，恢复环境。资源分 policy GPU、render/sim GPU、CPU、设备/操作者独占；real-time profile 明确 wall clock、sim clock、丢帧、缓冲与迟到动作。
3. **评分/有效性：**采纳原始 success predicate、reward、约束/安全指标或 human preference；记录 horizon、terminated/truncated 和初态。物理失败是有效结果，未完成 reset 或传感器流损坏可能无效；碰撞/急停的归属须按 agent 行为还是设施故障定义，不能一概丢弃困难 episode。
4. **轨迹/review：**高频 observation/action/time/reward 与多 camera 视频、state snapshot、policy latency；保留 native 数组/Parquet 和同步索引。UI 以 episode/timeline 为单位，关联 agent/推理 trace；重放是否等价须单独验证。
5. **校准：**动作单位/坐标/方向测试、已知 policy、reset determinism、控制周期、频率与 latency 压测；sim 进行 native-runner 同初态比较；real robot 用匹配任务、顺序控制和重复测量。静止/随机 policy 不保证 success=0；真实设备不承诺 bitwise replay。

依据：D 的 [VLA 架构][vla-arch]、[LIBERO][libero]、[SimplerEnv][simpler]、[LeRobotDataset][lerobot-data]、[RoboArena][roboarena-paper]；C 的 [维度契约][vla-specs]。

### C7 游戏与多主体环境

1. **输入输出：**声明 agent/player id、角色、各自可见 observation、合法动作、轮转/同步规则和最终 reward vector；支持单玩家、共享 team reward 和私有状态，不把所有消息拼成一个公开 transcript。
2. **生命周期/资源：**初始化 match、固定 opponent/team roster 与 seed，按环境规则推进并终止，清理所有参与者。资源按所有被运行主体计量；回合 timeout、同时行动 barrier、失联/弃权规则属于 profile。
3. **评分/有效性：**保留胜/负/平、回报、进展及协作目标；违法动作/超时可按游戏规则判负，server/reset 故障另记。对手进程故障是否判弃权必须预先声明；不能把被测 agent 的一次错误从分母删掉。
4. **轨迹/review：**保存事件顺序、player id、可见性、动作、合法性裁定、环境状态摘要、每主体 reward；review 可以显示全知视图，但不得反向将隐藏信息提供给 agent。对抗 agent 的身份与评审 judge 的身份分开。
5. **校准：**规则边界、胜负/平局、非法动作、角色互换、固定 scripted opponent、seed 重复；对比时控制 opponent pool、先后手和配对安排。排行榜分数必须声明聚合算法，不能把 arbitrary rating 当二值 success rate。

依据：D 的 [TextArena][textarena]、[BALROG][balrog]、[AgentBench][agentbench]。具体 benchmark 的 Elo/其他 rating 实现，本报告**未核实**。

## 6. 轨迹、结果与可观测性：值得采用什么

| 标准/格式 | 已核实的范围 | 适用类别与建议（P） | 不能据此保证的内容 |
|---|---|---|---|
| **ATIF** | D：Harbor 提供 agent trajectory 的会话、steps、工具交互、指标与子轨迹结构；Cua Bench 文档声明输出 ATIF 轨迹。[Harbor ATIF][atif]、[Cua Bench][cua-bench] | C2/C3/C4 及 C5/C6 的 agent 层；作为共同会话视图和导入/导出格式，记录 schema version。 | 不自动表达高频连续控制、完整 VM 状态、所有声音时序或评分可信性；不能从一个 ATIF 文件推定所有 tool results 和环境证据完整。 |
| **Inspect EvalLog** | D：`.eval`/JSON 保存 sample、消息/事件、scores、模型调用等，支持查看和重试日志；error handling 文档解释 retries 与评分行为。[Eval logs][inspect-logs]、[errors][inspect-errors] | C1–C4 的样本级 provenance 和可重评分结果很有参考价值；保留原生 log，再映射到共同索引。 | 一个框架日志并非所有其他框架已采纳的标准；导入时应声明字段损失，不能只留下顶层平均分。 |
| **BrowserGym 原生记录** | C：`StepInfo` 写 screenshot、`step_<n>.pkl.gz`，并有可选 `steps_info.json`。它**不是统一名为 JSONL 的原生格式**。[`loop.py`][bg-loop] | C5/browser：保留原始步骤文件和媒体，转成稳定、版本化的 review 索引；如需安全跨环境交换，另行显式导出结构化数据。 | 原生 pickle 不是通用交换协议；截图序列与视频不能证明可重新执行出同一网站状态。 |
| **VisualWebArena / live-web traces** | D：VisualWebArena 发布 HTML agent trajectories 和部分 Playwright traces；Online-Mind2Web 定义 screenshots + result/逐步记录供 judge 评估。[VWA][visualwebarena]、[Online-Mind2Web][online-mind2web] | C5：浏览器 trace 可作为环境证据，agent trajectory 则记录意图与动作；通过 step/call/time id 连接。 | 不同项目的 trace 不是天然同 schema；live web 的后验重放不能恢复过去真实世界全部状态。 |
| **LeRobotDataset v3** | D：用 Parquet 表格数据、视频和 metadata 描述多 episode、多模态机器人轨迹；v3 的存储分片与逻辑 episode 边界应由 metadata/index 关联。[官方文档][lerobot-data] | C6：适合机器人数据与离线分析；保留 camera/time/action 对齐。按可表达字段导出，缺失 proprioception 不能补造。 | 它不是统一在线 RPC，也不定义所有 benchmark 的 success、validity、policy 权限或 real-robot reset。 |
| **VLA harness 原生结果** | D：记录 step/episode/evaluation 数据并提供导出；C：collector 以 episode metric、steps、failure reason、任务聚合构造结果。[README][vla]、[collector][vla-collector] | C6：导入每 episode 与每 task 的充分统计量及原始结果；保留失败和 timing 指标。 | 不可只读 native summary 的一个平均数再平均；还须知道分母和缺 metric 的行为。 |
| **OpenTelemetry GenAI semantic conventions** | D：agent 相关 spans 包含 agent 创建/调用、workflow、tool 等操作；所查规范标注 **Development**。[官方规范源码][otel-agent] | 所有类别的模型/agent/工具调用链、跨服务耗时与错误关联；与 benchmark trial/sample/episode id 连接并固定 convention 版本。 | OTel 是可观测性约定，不能替代 ground truth、原始 artifact、聚合、episode reset 或 benchmark validity；span error 也不等于任务得 0 分。 |

**P：推荐“三层记录”，无需强迫所有数据变成聊天。**

1. **共同索引层：**`benchmark/profile/task/sample/attempt/episode/match/participant` 标识；事件 id、parent id、调用关联、wall time 与可选 sim time；产物 hash、producer、媒体类型、版本和完整度。结果包括 execution、evaluation validity、cleanup、指标与评分证据引用。
2. **类别原生层：**C1 请求响应；C2 workspace/patch/训练及 reproduction；C3 tool call + 状态 diff；C4 双方会话/音频；C5 GUI observation/action；C6 高频数组/视频；C7 按角色记录的事件和 reward vector。原文件作为权威来源，转换索引不得丢失原分数。
3. **review 层：**按类别显示最有解释力的内容；允许“完整会话 / 只有环境 / 只有产物 / 截断”等完整度声明。媒体缺失、归一化导入失败与评分有效性是独立维度；只有原协议把该媒体作为必要评分证据时，缺失才使分数不可验证。

**D：Orbit 已有接近这一方向的设计，但不可全当完成态。** `design.md` §9.8 提出了统一事件与原始媒体引用，并单独说明首个 EFE 导入器的范围；其中“BrowserGym JSONL”的简称应与实际版本源码核对。本文未检查该导入器实现，所以其运行覆盖为**未核实**。[Orbit design:916](orbit/docs/design.md:916)、[BrowserGym 实际写入代码][bg-loop]

## 7. 有效性、分母、聚合与 judge 可靠性

### 7.1 外部没有一个共同的“error 就是 0”规则

| 证据 | 实际行为及边界 |
|---|---|
| **Inspect（D）** | 默认 runtime error 可使评估失败；允许继续时，errored samples 默认不评分。`score_on_error` 可在重试耗尽后对部分状态评分。重试生成可追踪的新日志，文档提醒错误/重试可能产生选择偏差。模型拒答并不默认等于运行错误。[errors 文档][inspect-errors] |
| **τ-bench（C）** | `run.py` 的 `agent.solve` 捕获异常分支构造 `reward=0` 并保存 error，后续平均 reward 包含它。**限定范围：**该代码中环境创建在 try 之外，因此不能扩大成“所有初始化故障都被计零”。[代码 66–96、180–203][tau-run] |
| **vla-evaluation-harness（C）** | collector 保留带 `failure_reason` 的 episode 并计 `num_errors`，聚合时不因 failure flag 单独剔除。**限定范围：**具体 metric 聚合只取存在且为数值/bool 的值；collector 自身并不为任意缺失 metric 自动补 0。错误 episode 的默认 success 值需结合生产端核实，本文未全面检查所有 runner。[代码 63–95][vla-collector] |
| **EFE（D）** | 当前协议把 infrastructure failure 视为无结果；另规定 agent 行动后导致的某些 simulator errors 属于 agent 的 0 分，并用标记区分。privileged 的实例/重放一致性与 standard 的 live verdict 有不同证据要求。[协议 §4][efe-protocol] |
| **Cua Bench（D）** | `attempts` 是 fresh sandbox 评测次数；`retries` 用于评测前的 sandbox 启动/连接恢复。两者对统计分母的含义不同。[文档][cua-bench] |
| **PaperBench（D）** | 指定 direct-submission 目录中的缺失提交可按该运行配置记 0；full/Code-Dev 的评分范围也不同。不能因此推断 judge 故障也应为 0，后者代码行为**未核实**。[README][paperbench] |

**C：Orbit 已把 execution、evaluation 与 cleanup 分开。** `Outcome` 保留分数、指标、失败类型和 episode 信息；closed failure-kind 集合含 `infra`、`agent_install`、`env_start`、`env_step`、`reset_failed`、`policy_start`、`policy_act`、`server_unreachable`、`call_watchdog`、`resume_failed`、`scorer_error`、`judge_unavailable`、`model_unavailable`、`budget_exceeded`。[contracts/bench.ts:328](orbit/packages/orbit/src/contracts/bench.ts:328)

**C：Orbit 当前分类与上游规则可能需要并列解释。** `classify()` 将 solve OOM、agent/model 安装/服务问题等处理为 setup 问题并令结果无效，即使保留了 grader 给出的分数；verifier timeout/缺评分也有专门路径。不能把这一 Orbit 可信性定义反推为所有 benchmark 的官方分母。[bench/classify.ts:58](orbit/packages/orbit/src/bench/classify.ts:58)

**P：类别规范应声明“任务失败、协议失败、设施失败”的判定证据，再映射到共享 closed enum。** 不能让 adapter 为每个 benchmark 随意发明 FailureKind，也不能把原始错误信息挤掉。保留 native error code/detail、责任角色、发生阶段、是否已有可信 score 和映射版本。预算耗尽、非法动作、拒绝、碰撞、time-limit truncation 均应按任务协议解释；不是名称中出现 error 就删样本。

### 7.2 需要分别保留的聚合语义

**C：`pass@k` 与 `pass^k` 不是同一指标。** HumanEval 的估计器计算在 n 个生成样本、c 个成功样本中，随机选 k 个至少有一个成功的概率；τ-bench 的 `pass^k` 计算 k 次全部成功的组合比例，再跨任务平均。[HumanEval 代码][passk]、[τ-bench metrics][tau-run]

```text
pass@k(task) = 1 - C(n-c, k) / C(n, k)       # 至少一次成功
pass^k(task) =     C(c,   k) / C(n, k)       # 全部成功
```

**P：规范中必须固定 n、k、任务分组、独立采样方式、seed、缺项与错误计数。** 对一次成功和一次失败，k=2 时两者分别为 1 和 0；这只是公式示例，不是任何模型结果。HumanEval 实现还检查样本数是否足以报告指定 k；τ-bench 所查实现以 trial 索引数量作为 n，因此不能未经验证就用于缺 trial 的不完整集合。[HumanEval][passk]、[τ-bench][tau-run]（C）

| 聚合层次 | 建议保留的规则（P） |
|---|---|
| episode/sample → task | 原始 numerator/denominator、任务 seed/初态、错误及缺项；成功率、return、partial progress 不互相代换。 |
| task → suite/benchmark | 原 benchmark 的等权/加权规则；不要把 batch summary 再等权平均。举例：两批分别 1/1 与 1/9，批均值平均为 55.6%，合并样本为 2/10=20%；若它们代表两个需要等权的 task，则 55.6% 也可能是正确 task-mean。关键是声明统计单位。 |
| 重复尝试 | `attempt` 是计划中的统计尝试，`infra retry` 是协议允许的恢复；记录全部历史与结果选择规则。不能失败就补到成功，最后仅保留成功一次。 |
| rubric/研究任务 | 保存每项权重、叶节点证据、缺项和聚合版本；复现阶段失败与“未执行”不同；Code-Dev 与 full 不合并。 |
| 多主体/偏好 | 保存对手、角色、顺序、match/比较 id、tie、评审者及配对结构；rating/win rate 的定义、拟合算法与不确定性分开。偏好票不是独立同分布的固定任务 success bit。 |
| 不确定性 | 使用与抽样单元匹配的分层/聚类方法；同任务不同 seed、同场景不同 policy、同评审者多票不能简单当完全独立样本。报告任务/场景覆盖，避免只提供小数点。 |

**C：Orbit 当前 `OfficialRule` 的表达力比“任意官方聚合”窄。** schema 支持 `errors=exclude|fail`、`unit=sample|task`、`failValue` 和 metric；`officialValue()` 实际计算样本均值或任务均值的均值；`summarize()` 另对 valid trials 做任务级汇总。因此此实现不能直接表示 pass@k、pass^k、成对 rating 或任意 rubric 权重树。[contracts/bench.ts:364](orbit/packages/orbit/src/contracts/bench.ts:364)、[bench/summary.ts:66](orbit/packages/orbit/src/bench/summary.ts:66)、[bench/summary.ts:94](orbit/packages/orbit/src/bench/summary.ts:94)

**C/P：还有一个 completeness 边界需要注意。** 当前 `officialValue()` 对 pending/unknown 增加 missing，invalid 按规则处理；valid 但所选 metric 为 null 时跳过，不增加 missing。因此 `partial=false` 本身不足以证明所有计划样本都有这个 metric。建议在每 metric 上输出 eligible/scored/excluded/invalid/missing，并把原始 benchmark summary 及聚合器 provenance 附在报告中。[bench/summary.ts:71](orbit/packages/orbit/src/bench/summary.ts:71)

**P：正式展示至少并列四项：**计划/完成/有效/实际计分样本数，benchmark 官方口径，Orbit valid-only 口径，错误/缺项与版本偏差。复杂聚合可通过声明式聚合器或隔离运行的原官方 scorer 计算，但仍由同一个 daemon 接收证据、记录版本并出报告；不另建一套平台状态机。只有重试、结果选择、scorer 和分母均匹配原协议，才标“官方口径复现”；否则应叫“native scorer under modified protocol”。

### 7.3 Judge 可靠性和 calibration

**D：judge 的验证本身也是评测的一部分。** PaperBench 提供 JudgeEval 相关资源；Online-Mind2Web 同时讨论自动评估与人工评估并记录评估器变化；RoboArena 的成对设计强调匹配条件和双盲。这些都说明“有一个分数”不等于分数已被独立验证。[PaperBench][paperbench]、[Online-Mind2Web][online-mind2web]、[RoboArena][roboarena-paper]

**P：每个 scorer profile 至少声明：**judge model/provider/version、prompt/rubric、输入证据范围、温度/seed、解析规则、重试和不可用规则；人工评分则声明 instruction、盲法、tie/abstain 与 adjudication。校准样本应覆盖正例、负例、部分成功、长轨迹、模糊证据和边界行为；报告人工一致率以及成功/失败方向的误判，避免仅用平均 agreement 掩盖偏差。对成对 judge 检查顺序交换；对 safety judge 同时报 benign utility 与目标风险指标，拒答不是通用 error。

**P：校准应分四种证明，分别报告。**

1. **接口可运行：**能发现任务、启动被测系统/环境、拿到证据并清理。
2. **评分可区分：**按 benchmark 声明的正负/边界样本得到预期值或范围；不存在 oracle 时用已知 baseline 或固定证据，并如实标记。
3. **协议保真：**相同数据/初态/模型/预算下，原 runner 与 Orbit 的 action、结果、分母可解释地一致。
4. **真实方法验证：**至少一个真实 agent/policy 走完 observation→decision→action→score；统计波动用重复试验评估。空方法、oracle 和 scripted path 都不能单独替代此项。

**D：Orbit 文档已有保真度分级，但两处校准描述应区分。** §9.10 允许 benchmark 声明期望值或范围，并区分校准、原生样例对齐、真实方法对照；§9.14 描述现有 calibrate 的 empty=0/oracle 满分检查，且正向真实方法对照仍需人工。该 CLI 的完整实现本报告**未核实**。建议类别规范采用前者的广义要求，具体工具是否能表达这些要求另行审计。该保真度 L0–L4 与接入层 L0/L1/L2 同名但含义不同，报告/UI 应使用全称。[design:943](orbit/docs/design.md:943)、[design:1002](orbit/docs/design.md:1002)

## 8. Orbit catalog 已覆盖什么、缺什么

**D：这里的“有/缺”仅指当前 catalog 是否列出相应 benchmark/profile，不代表平台代码绝对不具备能力。** catalog 自己说明 runnable 是有条件可运行，calibrated 是本机校准记录，二者都不代表与官方成绩做过对齐。本文未重跑这些记录。[catalog:3](orbit/docs/catalog.md:3)

| 生态中反复出现的类别/profile | catalog 可见现状（D，运行未核实） | 缺口与建议（P） |
|---|---|---|
| 工作区 coding / research / simulator-program | EFE、TB、ASI、LongDS、ResearchClawBench、PostTrainBench 已列出；校准方式和覆盖不相同。[catalog:9](orbit/docs/catalog.md:9)、[catalog:17](orbit/docs/catalog.md:17) | C2 不是空白；应区分 terminal、patch、研究 reproduction 与 EFE mode。不要另设一个只按题材划分的 research 平台。 |
| 原生机器人 policy / sim | 列出 vla-eval LIBERO spatial，校准证据主要为 empty。[catalog:11](orbit/docs/catalog.md:11) | C6 已有入口；仍缺 catalog 可证的真实 policy 正向和 native parity。 |
| GUI/browser、desktop、mobile | BrowserGym/MiniWoB、CUA-Lite、Cua basic desktop、MobileWorld、OSWorld-V2 均已列；后两者注明未跑 KVM 校准。[catalog:12](orbit/docs/catalog.md:12) | C5 已有多条实现路径，但“列出”不能当所有平台已经实测。应按 browser/desktop/mobile 收敛规范。 |
| **Live web** | CUA-Lite 行已列 WebVoyager、Online-Mind2Web，注明 Web suites 需 assets、模型校准待完成。[catalog:13](orbit/docs/catalog.md:13) | **不是完全缺失**；缺的是已验证、可报告的 live-web profile，特别是网站变化、任务失效与 judge 证据规则。[Online-Mind2Web][online-mind2web] |
| **固定输入模型评测 / function calling** | catalog:9–19 未单列 lm-eval、simple-evals、BFCL 或同类 benchmark。[catalog](orbit/docs/catalog.md:7) | 补 C1，并显式区分 likelihood、生成、静态 tool-call AST 与 C3 执行循环。[lm-eval][lm-model]、[BFCL][bfcl] |
| **通用业务工具 / MCP workflows** | catalog 未单列 MCPMark、MCP-Universe 等代表；已有 coding agent 会用工具不等于这类任务已集成。[catalog](orbit/docs/catalog.md:7) | 补 C3 的状态 reset、API 服务和权限/副作用契约。[MCPMark][mcpmark]、[MCP-Universe][mcp-universe] |
| **工具 + 模拟用户** | catalog 未单列 τ-bench/τ² 或 user-simulator profile。[catalog](orbit/docs/catalog.md:7) | 补 C4，特别是双控制、用户模型身份及双方轨迹；并非给 C3 追加一段 prompt 就足够。[τ²][tau2-paper] |
| **游戏 / 多主体** | catalog 未单列 TextArena/BALROG；EFE 总表可能含比赛相关套件，但不能据总名称确认通用多玩家协议覆盖。[catalog:9](orbit/docs/catalog.md:9)、[EFE README][efe] | 补 C7 或验证其 match profile；具体 EFE 比赛集成覆盖**未核实**。[TextArena][textarena]、[BALROG][balrog] |
| **Safety / red-teaming** | catalog 未独立声明 threat model、攻击者 profile 或安全指标；EFE 上游有安全套件不等于 Orbit 已校准这些安全评估。[catalog](orbit/docs/catalog.md:7)、[EFE README][efe] | 补跨类别 safety profile，先选择已明确定义攻击边界的 benchmark；保留 utility 与攻击效果。[AgentDojo][agentdojo]、[HELM Safety][helm-safety] |
| **Speech / multimodal QA** | GUI/具身虽然用图像，catalog 没有单列固定音视频 QA 或实时语音用户会话。[catalog](orbit/docs/catalog.md:7) | 固定 QA 属 C1，实时语音服务会话属 C4；图像输入本身不是此能力已覆盖的证明。[HELM][helm]、[tau2-bench][tau2] |
| **真实机器人** | catalog 未列 real-robot 运行；design §9.11 把真机设备 provider 写为第二阶段方案。[catalog](orbit/docs/catalog.md:7)、[design:950](orbit/docs/design.md:950) | C6/real-device profile，包括独占 lease、operator/reset/stop 与校准；不能把 sim 结果叫真机能力。[RoboArena][roboarena-paper] |
| **人工偏好 arena** | catalog 未单列人工配对、评分者或 preference aggregation。[catalog](orbit/docs/catalog.md:7) | 加 pairwise-human scorer/collection profile；不新建与主体 IO 脱节的类别，也不复用单纯 task mean 当排名。[Chatbot Arena][chatbot-arena]、[RoboArena][roboarena-paper] |

## 9. 如何直接按类别集成，而不再以 hub 为目录主轴

**D：与现有设计的关系需明说。** Orbit `design.md` §9.14 的旧原则是跟随 hub/协议，并定义 Harbor L0、manifest L1、SDK L2；这些层最后仍编译成同一个 adapter 协议。用户本次要求改成类别规范与 benchmark 直接接入，因此本报告建议改变语义组织和入口身份，保留可复用的执行机制。该建议不是声称当前设计已经这样做。[design:979](orbit/docs/design.md:979)

**P：把三个正交概念分别命名。**

| 概念 | 回答的问题 | 示例 |
|---|---|---|
| Category + profiles | 被测系统如何交互、生命周期和证据是什么？ | C6 + simulator + synchronous-policy；C2 + EFE-standard；C5 + browser-live。 |
| Benchmark identity | 采用谁的任务、数据、实例、评估条件与 scorer？ | 原生 LIBERO spatial、EFE 的某 suite/mode、WebArena 某版本。 |
| Integration mechanism | 用什么实现代码接进共享执行协议？ | Harbor task loader、manifest、Python SDK、BrowserGym 库、VLA transport。这不出现在 benchmark 身份的必经父级。 |

**P：具体注册应类似下表。** 表内 id 是建议命名示意，尚未创建；native parity 一律不能由名称推定。

| 直接注册的 benchmark/profile | 主类 | 可以复用的实现 | 必须防止的身份混淆 |
|---|---|---|---|
| `swe-bench/verified/<revision>` | C2/repository-patch | 原官方任务/测试环境；Harbor 或 SDK 只负责装载/运行。 | “经某 hub 转换”不自动保证测试/预算/覆盖与原始协议一致。[SWE-bench][swe]、[registry parity][tb-registry] |
| `libero/spatial/native-policy/<revision>` | C6/sim | LIBERO 原生环境；可用 VLA harness 的 policy server/client 组件。 | 被测对象是 policy；不要把 EFE 控制代码结果算入这个 benchmark。[LIBERO][libero]、[VLA][vla-arch] |
| `efe/<suite>/<mode>/<revision>` | C2/simulator-program | EFE 自己的任务、API 与 scorer；Harbor loader 可直接读取。 | EFE 重构了评测问题，因此 EFE 本身就是有效 benchmark 身份；这正是允许保留 re-packaging 的情形。[EFE 协议][efe-protocol] |
| `webarena/<revision>`、`miniwob/<revision>` | C5/browser | BrowserGym 或原官方环境；引用一致的任务 id。 | BrowserGym 是库，不把它当中间 benchmark 层；agent 看到的 DOM/screenshot 权限需匹配。[BrowserGym][browsergym]、[WebArena][webarena] |
| `online-mind2web/<taskset>/<judge-version>` | C5/browser-live | 原任务与 evaluator，可复用 CUA-Lite browser transport。 | 日期/任务有效性/judge 改动会改变实验，不能与冻结 WebArena 混成同分母。[Online-Mind2Web][online-mind2web] |
| `tau2/<version>/<domain>/<user-profile>` | C4 | 直接用原域状态和 user simulator；共享工具 client。 | user model、dual-control 和 voice/text 是协议组成，不能当 agent 自带任意配置。[τ²][tau2-paper]、[当前仓库][tau2] |
| `bfcl/<version>/<test-category>` | C1 或 C3，按 profile 固定 | 原数据、parser、执行器和 scorer；共享 model backend。 | “function calling”大标签不足以表达静态 AST 与在线 tool loop。[BFCL][bfcl]、[分类][bfcl-categories] |
| `textarena/<game>/<rules>/<opponent-set>` | C7 | TextArena 环境与 agent callable。 | 不把 opponent 当 judge；版本与对手集合不可隐藏。[TextArena][textarena] |

**P：共享底座只需要一套。** 沿用 daemon 对任务计划、资源 lease、run、状态和结果的所有权；类别 SDK 提供不同 hooks/schema 与 capability validation，不提供另一套队列/ledger。共享执行流程可表达 prepare、readiness、solve/episode、verify、collect、cleanup，类别仅决定这些阶段的输入、角色与证据。Orbit 的既有约束明确要求 daemon 唯一写状态、不建第二状态机，并将 execution/evaluation/cleanup 分离。[AGENTS.md:25](orbit/AGENTS.md:25)（D）

**P：每个直接 benchmark 条目应给出最小完整声明：**

```text
identity: 原始任务来源 + revision + task/split/instance digest
category: C1..C7；required profiles；被测 subject/scaffold 的边界
io: 输入/输出 schema、可见信息、工具与动作权限、结束信号
environment: providers、reset/readiness/stop/cleanup、隔离范围
resources: 按 role 的 CPU/RAM/GPU/disk/device/API 配额和时钟预算
scoring: 原 scorer + version + evidence 输入 + 官方聚合/缺项规则
validity: 原 error → 共享 failure-kind；任务失败与设施故障边界
trajectory: 原格式 + 公共索引映射 + 完整度 + producer/trust
calibration: 正负/边界样本期望、native parity、真实方法、偏差清单
```

上述为概念契约，**不是现有配置文件 schema**。是否落成 L1 清单或 L2 hooks 由表达需求决定；不为分类另造执行通道。只有 benchmark 本身定义新的问题/协议，才将 re-packaging 作为新的 benchmark；只是转码、调用或统一 launch 的 hub 应保留为实现依赖。

## 10. 未核实事项与使用边界

| 项目 | 本报告已确认 | 仍未核实，不能据此声称 |
|---|---|---|
| 本机运行/性能 | 阅读本地文档与指定代码；读取外部官方源。 | 所有外部项目的安装、Docker/GPU/KVM/real-robot 运行、吞吐与分数；没有执行 benchmark。 |
| EFE/upstream parity | 文档明确 coding-agent 与不同 mode 契约。 | 35 suites 的逐题对应、所有 sidecar/scorer 实现、与原生 policy benchmark 的成绩等价。 |
| HELM agent 变体 | 查到 HELM 主体、Safety 和多模态系列。 | 独立官方 “HELM Agent” 接口；HAL 与 HELM 同源的说法。 |
| GUI 统一动作 | 读到 BrowserGym、CUA-Lite 的核心抽象。 | 全部 backend 的坐标、动作、reset、异常分母及 cross-hub parity。 |
| 真实机器人/arena | 官方论文和项目页描述 remote policy、真实设备、成对评价。 | 当前设备可用性、精确排名算法的实现、Orbit 已支持设备 lease 或人工评审工作流。 |
| errors/aggregation | 读了 HumanEval、τ-bench、VLA collector 和 Orbit 相应函数。 | 其他所有 runner 的异常分母；VLA 每条生产端路径是否补 success=0；OSWorld 是否一律计 error=0。 |
| standards | 官方文档或代码说明现有格式。 | 所有字段跨版本稳定；ATIF/OTel 能无损覆盖全部类别；任何标准自动保证可复现或评分正确。 |
| catalog | 文档列出的有条件覆盖及校准记录。 | “runnable=官方复现”“empty 通过=真实方法可用”“hub 支持矩阵=本机实测”。 |

本报告的实施建议是：先把现有 C2/C5/C6 条目按 subject 与 profile 重新命名，保留其原始证据与版本；用 C1、C3、C4、C7 的代表 benchmark 检验类别规范是否足够。优先验证会改变公共契约的差异——likelihood、业务状态 reset、双向用户控制、玩家调度、真实设备与偏好聚合——而不是以新增 hub 数量衡量覆盖。本段为 P；对应现状与外部证据见第 2–9 节。

<!-- References: official sources read during this investigation. -->

[hal]: https://github.com/princeton-pli/hal-harness/blob/main/README.md
[helm]: https://github.com/stanford-crfm/helm/blob/main/README.md
[lmeh]: https://github.com/EleutherAI/lm-evaluation-harness/blob/main/README.md
[openai-evals]: https://github.com/openai/evals/blob/main/README.md
[agentbench]: https://github.com/THUDM/AgentBench/blob/main/README.md
[openenv]: https://github.com/openenv/OpenEnv/blob/main/README.md
[browsergym]: https://github.com/ServiceNow/BrowserGym/blob/main/README.md
[vla]: https://github.com/allenai/vla-evaluation-harness/blob/main/README.md
[simpler]: https://github.com/simpler-env/SimplerEnv/blob/main/README.md
[lerobot]: https://github.com/huggingface/lerobot/blob/main/README.md
[tau]: https://github.com/sierra-research/tau-bench/blob/main/README.md
[tau2]: https://github.com/sierra-research/tau2-bench/blob/main/README.md
[bfcl]: https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/README.md
[cua]: https://github.com/trycua/cua/blob/main/README.md
[balrog]: https://github.com/balrog-ai/BALROG/blob/main/README.md
[mle]: https://github.com/openai/mle-bench/blob/main/README.md
[rebench]: https://github.com/METR/RE-Bench/blob/main/README.md
[swe]: https://github.com/SWE-bench/SWE-bench/blob/main/README.md
[webarena]: https://github.com/web-arena-x/webarena/blob/main/README.md
[osworld]: https://github.com/xlang-ai/OSWorld/blob/main/README.md
[android]: https://github.com/google-research/android_world/blob/main/README.md
[mcp-universe]: https://github.com/SalesforceAIResearch/MCP-Universe/blob/main/README.md
[mcpmark]: https://github.com/eval-sys/mcpmark/blob/main/README.md
[mcpbench]: https://github.com/Accenture/mcp-bench/blob/main/README.md
[efe]: https://github.com/mll-lab-nu/embodied-first-exam/blob/main/README.md
[textarena]: https://github.com/TextArena/TextArena/blob/main/README.md
[bg-task]: https://github.com/ServiceNow/BrowserGym/blob/main/browsergym/core/src/browsergym/core/task.py
[lm-model]: https://github.com/EleutherAI/lm-evaluation-harness/blob/main/lm_eval/api/model.py
[simple-types]: https://github.com/openai/simple-evals/blob/main/types.py
[passk]: https://github.com/openai/human-eval/blob/master/human_eval/evaluation.py
[cua-bench]: https://github.com/trycua/cua/blob/main/libs/cua-bench/README.md
[vla-specs]: https://github.com/allenai/vla-evaluation-harness/blob/main/src/vla_eval/specs.py
[cualite-base]: https://github.com/cua-lite/cua-lite/blob/main/lite/gym/base.py
[tau-run]: https://github.com/sierra-research/tau-bench/blob/main/tau_bench/run.py
[bg-loop]: https://github.com/ServiceNow/BrowserGym/blob/main/browsergym/experiments/src/browsergym/experiments/loop.py
[vla-collector]: https://github.com/allenai/vla-evaluation-harness/blob/main/src/vla_eval/results/collector.py
[paperbench]: https://github.com/openai/frontier-evals/blob/main/project/paperbench/README.md
[online-mind2web]: https://github.com/OSU-NLP-Group/Online-Mind2Web/blob/main/README.md
[webvoyager]: https://github.com/MinorJerry/WebVoyager/blob/main/README.md
[otel-agent]: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md
[agentdojo]: https://github.com/ethz-spylab/agentdojo/blob/main/README.md
[libero]: https://github.com/Lifelong-Robot-Learning/LIBERO/blob/master/README.md
[helm-adapter]: https://github.com/stanford-crfm/helm/blob/main/src/helm/benchmark/adaptation/adapters/adapter.py
[bfcl-categories]: https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/TEST_CATEGORIES.md
[openenv-core]: https://github.com/openenv/OpenEnv/blob/main/src/openenv/core/env_server/interfaces.py
[vla-arch]: https://github.com/allenai/vla-evaluation-harness/blob/main/docs/architecture.md
[hal-agent]: https://github.com/princeton-pli/hal-harness/blob/main/agents/README.md
[android-task]: https://github.com/google-research/android_world/blob/main/android_world/task_evals/task_eval.py
[evals-api]: https://github.com/openai/evals/blob/main/evals/api.py
[efe-protocol]: https://github.com/mll-lab-nu/embodied-first-exam/blob/main/docs/protocol/README.md
[visualwebarena]: https://github.com/web-arena-x/visualwebarena/blob/main/README.md
[harbor-task]: https://docs.harborframework.com/tasks/overview
[tb-registry]: https://www.tbench.ai/news/registry-and-adapters
[atif]: https://docs.harborframework.com/agents/atif
[inspect-tasks]: https://inspect.aisi.org.uk/tasks.html
[inspect-agents]: https://inspect.aisi.org.uk/agents.html
[inspect-sandbox]: https://inspect.aisi.org.uk/sandboxing.html
[inspect-evals]: https://ukgovernmentbeis.github.io/inspect_evals/
[inspect-logs]: https://inspect.aisi.org.uk/eval-logs.html
[inspect-errors]: https://inspect.aisi.org.uk/handling-errors.html
[hal-site]: https://hal.cs.princeton.edu/
[simple-readme]: https://github.com/openai/simple-evals/blob/main/README.md
[helm-safety]: https://crfm.stanford.edu/2024/11/08/helm-safety.html
[gym]: https://gymnasium.farama.org/api/env/
[tau2-paper]: https://arxiv.org/abs/2506.07982
[gaia]: https://huggingface.co/datasets/gaia-benchmark/GAIA
[gaia-scorer]: https://huggingface.co/spaces/gaia-benchmark/leaderboard/blob/main/scorer.py
[lerobot-data]: https://huggingface.co/docs/lerobot/lerobot-dataset-v3
[isaac-arena]: https://isaac-sim.github.io/IsaacLab-Arena/main/index.html
[roboarena-paper]: https://arxiv.org/abs/2506.18123
[roboarena]: https://robo-arena.github.io/
[chatbot-arena]: https://arxiv.org/abs/2403.04132
[helm-paper]: https://arxiv.org/abs/2211.09110



