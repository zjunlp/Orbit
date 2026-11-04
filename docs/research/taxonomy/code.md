**Orbit：coding / terminal / software-engineering / research / QA benchmark 分类与直接接入规范**

**1．结论、证据口径与范围**

建议本 track 使用五个大类：**W 工作区工程任务、Q 答案与检索问答、R 开放研究报告、C 一次性代码生成、I 状态型工具交互**。分类先看被评测对象得到什么、能做什么、交付什么以及裁决需要什么证据，再看评分机制；`research`、`robotics`、`coding` 等领域标签不能代替交互契约。类别是本文的**设计建议**，不是声称 Orbit 已实现的新 API。

这个划分有直接的反例支撑：TB-Science 的数值任务提交 NPZ 并用脚本判定；ResearchClawBench 对报告逐条调用 judge；LongDS 对完整任务的每一轮答案判分；SandboxFusion 接收 `completion` 后执行代码；Harbor 的 BFCL 转换版要求提交函数调用 JSON，而 tau3 adapter 启动模拟用户和工具服务。因此，“都能放进 Docker”“都由 CLI agent 做”“最终都写 reward”不足以合并它们的规范。[TB 数值判据][tbgrade] [RCB 评分][rcbscore] [LongDS 完整性][lds] [completion 接口][sfapi] [BFCL 输入输出][bfclinstr] [tau3 配置][tauconfig]

本报告只核对本机文件，不下载 benchmark、不启动 Docker、不调用模型或 judge、不运行实验。**代码已核实**表示能在当前工作树找到相应实现，**配置已核实**表示数值或行为由配置声明；两者都不表示运行成功。仅 README、catalog、设计文档声称的效果，明确写成“文档记录，运行效果未核实”。所有未读到实现、未测量或无法从本地文件确定的内容均标为 **未核实**。实际耗时、峰值内存、GPU 显存和网络可达性，本次统一为**未核实**；下表资源数字均是配置预算，不是实测性能。

检索范围是用户指定的 10 个 benchmark/agent 仓库及 Orbit；另仅为 EFE 混淆问题抽查 EFE MetaWorld+ 任务和 vla-eval LIBERO 协议实现。文件链接均指向 `` 下本地文件，行号是本次工作树行号。工作树有未提交变更时以实际文件为准，不能用 HEAD 单独重建全部结论；末尾附读取时的 Git 快照。

**Harbor 覆盖的准确口径。** 本地 `harbor/registry.json` 是数组，共 **80 个 name/version 条目、75 个不同 name、51,625 个 task 引用**；后者包含不同版本、子集和重复任务，不能称为独立题目数。逐项清单和每条来源见附表 A。这是本地 JSON 的静态计数，**不是线上 registry 的完整实时目录**：`RegistryClientFactory.create()` 在默认情形选择 `HarborRegistryClient`，只有指定 `registry_path` 等情形才用 JSON client。当前线上目录是否与本地一致，未核实。[registry][registry] [client 选择][regfactory]

Harbor 的 adapter 目录另有若干没有出现在这 80 条中的转换器，例如 `tau3-bench`、`textarena`、`multi-swe-bench`；附表 B 完整列出 adapter 目录。**登记数据、存在转换器、可以在 Orbit 保真运行、校准通过、与原生成绩对齐，是五件不同的事。** Orbit catalog 自己也区分 runnable、calibrated 与官方对照；其中 ASI、LongDS、RCB/PTB 的记录不能扩张成全量实测认证。[catalog][catalog] [tau3 实现][tauconfig] [TextArena 实现][textserver]

**2．判定类别的规则与关键边界**

| 类别 | 被评测对象与核心契约（建议） | 判定依据与例子 |
|---|---|---|
| **W：工作区工程任务** | Agent 获得可持续读写的项目/数据工作区，自主运行命令、修改代码或训练；交付 patch、文件、模型，或由工作区程序影响的可信服务状态；验收以可执行 verifier 为主 | SWE-bench 的修复后测试；TB-Science 数值文件；ASI 混合 gates/scorers；PostTrainBench 的 `final_model`。资源大或附加 judge 均不自动变成 R。[SWE][swegrade] [TB][tbgrade] [ASI][asiscoring] [PTB][ptb] |
| **Q：答案与检索问答** | 输入题目/上下文，可选受声明的计算与检索工具；被评分的对象是一个或有序多个答案，不是项目是否构建成功 | GPQA 字母、GAIA `answer.txt`、LongDS 每轮 solution、BFCL 函数调用 JSON；matcher、结构验证或 correctness judge。[GPQA][gpqagrade] [GAIA][gaiagrade] [LongDS][lds] [BFCL][bfclinstr] |
| **R：开放研究报告** | 自主研究或文献综合，交付报告及证据包；多条 rubric / 论证覆盖 / 引用支持共同形成主成绩 | RCB、ScholarQA、Asta E2E；不是“凡 LLM judge 都属于 R”，SimpleQA 仍是 Q。[RCB][rcbscore] [SQA][sqatask] [E2E][e2e] |
| **C：一次性代码生成** | 模型获得固定 prompt/messages，返回代码 completion；受测对象没有可自主迭代的任务 workspace；可信执行器抽取、编译、运行并评分 | SandboxFusion HumanEval、MBPP、LiveCodeBench。模型生成过程和测试执行分开。[接口][sfapi] [HumanEval][sfhe] [MBPP][sfmbpp] [LCB][sflcb] |
| **I：状态型工具交互** | Agent 接收工具 schema、观察/用户消息，通过动作改变持久环境；被评分对象包含整个会话、工具副作用、终局状态 | tau3 的模拟用户、领域工具及 evaluator；TextArena 的 observation/action/result。固定函数调用字符串题不在此类。[tau3 evaluator][taueval] [TextArena][textserver] |

具体采用以下优先级，避免类别重叠：先识别 C 的“无任务执行反馈”契约；再区分 I 的“受测接口本身是领域会话/动作循环”；其余以交付物裁决为主，报告 rubric 为 R，答案匹配为 Q，工程产物/可执行行为验收为 W。工作区中为了得到答案而编写临时脚本，不会把 Q 自动改成 W；Docker 是隔离方式，不是类别。相同 benchmark 如果提供两种实质不同的交互方式，登记两个 variant，不强行二选一。这些都是**建议规则**。

需要单独澄清的边界：

- **Harbor LiveCodeBench ≠ 一次性 LiveCodeBench completion。** 本地转换器明确要求创建 `solution.py`，运行 `check_solution.py`，失败后反复修改；因此这里是 W 的竞赛编程 profile。SandboxFusion 的同名家族从 `SubmitRequest.completion` 抽取代码并交给执行器，是 C。二者可共用原生测试语义，但不能自动把 agentic pass rate 当作原生 single-shot pass@1。[Harbor LCB][hlcb] [SandboxFusion LCB][sflcb]
- **BFCL 不应一律叫 interactive tool use。** 本地 Harbor 指令要求写 `/app/result.json`，并不要求调用真实函数；其中 relevance 评分甚至只检查可解析且非空的调用列表。该转换版应归 Q/structured-call。BFCL 其他原生交互子集的完整行为，本次未核实。[BFCL 指令][bfclinstr] [relevance evaluator 生成器][bfcladapter]
- **LongDS 的多轮不等于模拟用户。** adapter 枚举 `task.json` 中已有 question/context/answer 列表，native runner 产出逐轮 solution，再用原 `judge_one` 评分；未看到由模拟用户模型动态决定下一题的协议。归 Q/ordered-session，保留顺序、上下文和任务内依赖。[LongDS adapter][lds] [runtime][ldruntime]
- **SWE-Lancer IC 与 manager 必须拆开。** manager 的验收是 `selected_proposal_id` 相等；IC 使用不同 verifier。共享品牌不能抹掉“修代码”和“选 proposal”差异。manager 属 Q，IC 属 W。[manager 验证][swemanager] [IC 验证][sweic]
- **ResearchClawBench 与 ResearchCodeBench 是不同 benchmark。** 前者读取 `report/report.md` 并按 checklist 加权；后者向论文代码片段注入实现并运行 pytest，输出还带 `code_lines`。分别归 R 与 W，不能缩写成同一个 RCB。[ResearchClawBench][rcbscore] [ResearchCodeBench][researchcode]
- **ASI 不宜笼统叫“LLM 科研评审”。** 例如 scRNA 任务含文件门槛、代码模式门槛、ARI、Spearman、F1、AUROC；另有任务含 `llm_judge` 或 `multimodal`。建议 W/scientific-artifact + 可组合的 judge stage，按任务保留门槛和权重。[scRNA 配置][asisc] [LLM 子项][asijudgeexample] [统一评分核心][asiscoring]
- **CooperBench 的 multi-agent 是 W 的联合角色 profile。** verifier 等待两个 sidecar 的 patch，合并后测试；统计样本应是 feature pair 的联合任务，不是把两个 agent 分别当两道独立题。TextArena 本地 server 则显式 `num_players=1`，不能因游戏框架名称就声称验证了多玩家对抗。[CooperBench verifier][cooptest] [TextArena reset][textserver]

**EFE 与 policy 的边界。** EFE 抽查任务的指令要求 coding agent 写控制程序，调用 `Robot.spec/get_obs/submit`；还明确“没有另行提交物”，服务记录 episode 并对最后一个控制步后的状态评分，`gen.py` 只留档。因此 EFE standard 不只是离线“交代码跑单测”，需要 W 的 **live-sidecar** profile：CLI workspace 是受测入口，可信仿真证据是评分来源。指令中这些语义已核对；该任务的实际物理执行效果本次未核实。[EFE 指令][efe]

与之相对，vla-eval 的协议定义 `EPISODE_START / OBSERVATION / ACTION / EPISODE_END`，LIBERO adapter 接收 7 维动作并执行 simulator step。它评的是 policy 的 observation→action 契约，不能归入本 track 的 CLI workspace 类，更不能用 EFE 的成绩代表 native LIBERO policy 成绩。完整 policy 类规范应由具身 track 给出；这里仅划清入口。EFE 涉及“35 套件”的数字是 Orbit catalog 记录，本报告没有逐套核对，故**35 套完整重包装清单未核实**。[VLA 协议][vlaproto] [LIBERO step][vlalibero] [catalog][catalog]

**3．已检查实现的 benchmark / dataset 对照表**

表内 **S/V** 分别为 solve/verifier 配置上限；CPU 与内存是容器/adapter 声明。`public` 只说明允许联网，不等于题目必需联网。下载依赖、模型 API、任务检索、judge API 分开标注。**“评分为纯脚本”只说明同输入下的判定逻辑，不构成端到端确定性证明**；所有未做重复运行的确定性保证仍为未核实。

| Benchmark / variant（建议类） | subject、环境、输入 → 产物 | 评分与证据 | 资源/运行时配置；联网与确定性 |
|---|---|---|---|
| SWE-bench Verified（W） | Harbor CLI workspace；issue + repo → 修改后的代码/patch | `swebench==4.0.3` harness，FAIL_TO_PASS / PASS_TO_PASS，FULL resolved 才为 1；保存 report.json。[转换器][sweadapter] [评分][swegrade] | 1 CPU、4096 MB、0 GPU；S/V=`max_timeout` 参数；两阶段 public。verifier 使用 uv 依赖；测试稳定性、真实耗时未核实。[配置][sweconfig] |
| SWE-bench Pro / Multilingual / Multi-SWE-Bench / SWE-smith（W） | 各自 repo/image、问题与变更；不能借 Verified 的 task 数替代 | Pro 独立 parser/test set；Multilingual SWE harness；Multi-SWE `run_tests.py`；SWE-smith pytest/harness。已检查入口，全部原生 parity 未核实。[Pro][sweprotest] [Multilingual][swemultitest] [Multi-SWE][multiswetest] [Smith][smithtest] | Pro 1 CPU/4096 MB/0 GPU；Multilingual 4 CPU/8192 MB/0 GPU；Multi-SWE 参数化；Smith S/V 3000s。联网依赖及每个测试的确定性需按任务核验，不能推广为统一配置。[Pro配置][sweproconfig] [多语配置][swemulticonfig] [Multi配置][multisweconfig] [Smith配置][smithconfig] |
| SWE-bench Full / Lite | 本地 Verified loader 固定加载 Verified/test | **Full/Lite 接入未核实**；本地 JSON 无这两个条目，不能从 SWE-bench 家族名推断支持。[loader][sweadapter] [完整 registry][registry] | 输入、评分、资源、网络、确定性均未核实 |
| SWTBench Verified（W/test-authoring） | repo → 新测试 patch | 同一 model test patch 分别运行在 base code、gold code，再解析结果；不是一般的修 bug pass rate。[verifier][swttest] | S/V 1200s；verifier `pip install unidiff`；CPU/GPU模板未声明，实际需求未核实。[配置][swtconfig] |
| SWE-Lancer diamond IC / manager（W / Q） | IC 改项目；manager 交 `manager_decisions.json` | IC 独立测试脚本；manager 精确比较 proposal ID；registry all=463、ic=198、manager=265，是包含关系。[IC][sweic] [manager][swemanager] [registry][registry] | 共用模板 1 CPU/8192 MB，S/V 3000s；额外服务和每题联网必要性未核实。[配置][lancerconfig] |
| Terminal-Bench 2.0 / sample / Pro（W，逐题可附服务或训练 profile） | 本地 registry 的 terminal 环境任务；详细任务 payload 位于外部 git 引用 | JSON 分别登记 89、10、200 个引用；本地未下载这些 task 目录，**逐题输入、产物、scorer、资源和网络未核实**。不以 TB-Science 样本替代。[registry][registry] | Orbit catalog 另记录 TB 4.0 56/66 runnable，属于文档记录、实际运行未核实；不能把它当作 registry 的 TB 2.0。[catalog][catalog] |
| Terminal-Bench-Science（W/scientific-artifact） | 科学数据 + 工作区 → 数值结果/模型文件。例：sparse-network-assimilation 交 `result.npz` | 当前 `tasks/` 静态枚举 70 个 task.toml，均声明 separate，均未声明非零顶层 GPU；样例脚本验五项数值门槛，全过才 1。该计数不代表 sidecar GPU 全无，也不代表 70 个全部运行过。[任务树][tbroot] [样例配置][tbconfig] [grader][tbgrade] | 样例 2 CPU/4096 MB/0 GPU，S 28800s、V 120s；solve public、verify no-network。hysteretic-aquifer-control V 300s，说明上限逐题不同。[样例配置][tbconfig] [另一题][tbconfig2] |
| Aider Polyglot / HumanEvalFix / QuixBugs（W） | 可编辑的语言项目或带缺陷程序 → 修复文件 | 本地 Harbor 包装有工作区测试入口，不能视为纯 completion 测试；详细语言执行器差异未逐项复核。[Aider测试][aidertest] [HEFix测试][hefixtest] [QuixBugs配置][quixconfig] | Aider 1 CPU/4096 MB/0 GPU、S/V 1800s；HEFix 1 CPU、S/V 600s；QuixBugs 1 CPU/2048 MB/0 GPU、S/V 600s。测试稳定性未核实；Aider/QuixBugs 配置 public。[Aider配置][aiderconfig] [HEFix配置][hefixconfig] [QuixBugs配置][quixconfig] |
| Harbor LiveCodeBench release_v6 抽样（W） | 编程题 → `solution.py`；允许反复运行公开样例 | final_test 合并 public/private cases，脚本产二元 reward；registry 是 100 题抽样，不能称完整 v6。[adapter][hlcb] [final tests][hlcbfinal] [registry][registry] | 1 CPU/2048 MB，S 360s/V 180s。样例反馈改变受测契约；隐藏测试隔离存在静态疑点，见第 5 节。[配置][hlcbconfig] |
| Harbor BigCodeBench-Hard / EvoEval / DS-1000 / AutoCodeBench / USACO（W 或代码答案 profile；不能直接称 C） | 经 Harbor 任务形式启动 agent；各自提交和测试文件 | BigCodeBench、EvoEval、AutoCodeBench、USACO 的 wrapper 执行 pytest；DS-1000 有专用测试入口。**每项是否严格限制为一次答案、与原生 completion 评测等价，未核实**。[BigCode测试][bigtest] [Evo测试][evotest] [DS测试][dstest] [Auto测试][autotest] [USACO测试][usacotest] | BigCode 2 CPU/4096 MB、S600/V480s；Auto 1 CPU/2048 MB、S600/V150s；USACO S600/V7200s。其余按配置，未声明项未核实；若 verifier 安装依赖则不能宣称离线。[Big配置][bigconfig] [Auto配置][autoconfig] [USACO配置][usacoconfig] |
| AlgoTune / GSO（W/performance） | 优化现有算法/软件 → solver 或 patch | AlgoTune 固定生成 seed，交错测 baseline/solver；reward 是 speedup，合法但慢于 baseline 的解可被设为 1。GSO 从 patch 调专门 evaluator；两者不能归一化成“全部测试通过=1”。[AlgoTune评分][algograde] [GSO入口][gsotest] | AlgoTune 8 CPU/16384 MB/0 GPU，S/V3600s；GSO S10800/V3600s，CPU/MEM参数化。计时受硬件与负载影响（推断自计时实现），重复稳定性未核实。[Algo配置][algoconfig] [GSO配置][gsoconfig] |
| ReplicationBench（Q/numeric-reproduction；若限制过程可另设 W variant） | 论文复现实验背景 + workspace → `result.json.value` | 递归比较数值、字符串、列表、字典；数值用绝对容差。当前主要交付裁决是答案正确性，不是报告质量或是否真实复现全部过程。[测试][repgrade] | 1 CPU/4096 MB/0 GPU，S3600/V1800s；两阶段 public；verifier apt/curl/uv 安装，离线运行未核实。[配置][repconfig] [入口][reptest] |
| ResearchCodeBench（W/implementation） | 论文算法 + 代码上下文 → 实现片段/修改文件 | 由日志注入代码后 pytest；reward.json 同时写 reward、code_lines。需保留提取策略，避免从不同 Agent 日志抽取不同实现。[测试][researchcode] | 模板预算见配置；真实GPU需求、全题耗时未核实；verifier 可 pip 安装 requirements。[配置][researchcodeconfig] [测试][researchcode] |
| CodePDE / SLDBench / QCircuitBench / RExBench（W/scientific-computation） | 专用科学任务 → solver、拟合式、量子程序或结果文件；具体产物格式由各题定义 | CodePDE verifier 下载数据并检查 nRMSE<0.05；其余分别进入 `test_outputs.py`、量子 evaluator、`numerical_eval.py`，不可从 research 标签推断 LLM judge。[CodePDE][pdetest] [SLD][sldtest] [QCircuit][qctest] [REx][rextest] | REx 24 CPU/40960 MB/1 GPU，S1800/V43200s；CodePDE 1 CPU/2048 MB且预算参数化；其余配置见链接，原生 parity未核实。[REx配置][rexconfig] [PDE配置][pdeconfig] [SLD配置][sldconfig] [QC配置][qcconfig] |
| MLGym-bench（W/training） | 数据、训练任务、workspace → 模型/预测及 evaluate.py 可消费产物 | evaluate.py 指标相对 baseline 算 reward；支持 continuous 模式、可有负 penalty；不是统一 accuracy，也不是统一二元 pass。[adapter][mlgymadapter] [测试][mlgymtest] | 24 CPU/61440 MB；GPU按任务和 no_cuda；预算 training_timeout 加额外量；两阶段 public。训练可重复性未核实。[配置][mlgymconfig] [adapter][mlgymadapter] |
| ML-Dev-Bench / FeatureBench（W） | ML 开发/feature 实现 → 项目变更 | 分别调用原 validator、feature 测试/日志解析；具体训练与 GPU 子集不能由名字推断。[MLDev测试][mldevtest] [Feature测试][featuretest] | MLDev 4 CPU/16384 MB/0 GPU，V1800s/S参数化；Feature配置只给部分默认值，GPU子集数量在 registry 不同包装的描述有不同口径，未逐题核实。[MLDev配置][mldevconfig] [Feature配置][featureconfig] [registry][registry] |
| ASI-Bench（W/mixed-scientific-artifact） | 当前 tasks 静态枚举 61 个 task_meta；实例 prompt/input/reference bundle → 指定输出文件 | hard/soft gates + weighted scorers；缺输出与 scorer crash 分开。Orbit 枚举的是本地 `__seed31415` 实例，非 61 个公开定义自动全可跑；review 标注 `non-official seed31415`。[任务树][asiroot] [评分核心][asiscoring] [Orbit实现][asi] | Orbit solve的process预约2CPU/8GB、requires_gpu则1GPU；verify预约1CPU/4GB、通常30min。CLI solve通过native OSSandbox启动Docker，其类默认CPU=4、memory=8g，可由调用者覆盖，不能将process预约当子容器已实施的配额；empty/oracle走sandbox=none。[native sandbox][asios] judge子项需模型服务；数值部分同文件重评分的稳定性未实测。[ASI adapter][asi] |
| PostTrainBench（W/model-training） | CLI agent + GPU训练环境；任务合同/基础模型 → `final_model/` | verify 调任务 evaluate.py，读 metrics.json.accuracy×100；本地 adapter 强制 `--limit 100`。只有 adapter 实现已核实，上游任务全集及各 accuracy 的实际定义未核实。[PTB adapter][ptb] | S8CPU/64GB/1GPU且80GB显存预算、660min；prompt默认10h；V4CPU/32GB/1GPU80GB、60min。native路径设置HF缓存offline flags，CLI路径显式改为0且solve允许公网；verify设置HF_HUB_OFFLINE=1但仍允许网络/API。无参考 oracle；训练确定性未核实。[PTB adapter][ptb] |
| LongDS（Q/ordered-session） | Codex/Claude native multi-turn runner；data + question/context 序列 → 每轮 solution、文件引用、native日志 | 原 judge_one，逐轮 binary correctness 再均值；缺轮、乱序、失败turn、judge error均invalid；empty/reference回放专供校准。[adapter][lds] [runtime][ldruntime] | S4CPU/16GB/0GPU，默认1440min、每轮3600s；V1CPU/2GB、120min；非空答案调用judge API。原生数据实际规模未核实，不能把 lite catalog 写成全量支持。[adapter][lds] |
| ResearchClawBench（R） | 当前任务树40个 task_info；data/related_work只读，code/outputs/report可写 → report.md及图表代码 | 原 score_run 对 text/image checklist加权，0–100；约50匹配参考论文是 adapter 的刻度约定。缺报告有效0，judge/条目失败invalid；默认 enhanced 与 official 模式需分开。[adapter][rcb] [scorer][rcbscore] | S8CPU/32GB/0GPU、240min、公网；V host process 1CPU/2GB、60min；外部judge API；attempts均值与spread，不确定性不能消除。无通用oracle。[adapter][rcb] |
| GPQA Diamond / AIME / MMMLU（Q） | Harbor CLI可计算，题目/选项 → answer文件 | GPQA规范化后只接受ABCD；AIME进入test_outputs；MMMLU shell验答案。这里的 workspace 包装不能证明原始闭卷单轮协议相同。[GPQA][gpqagrade] [AIME][aimetest] [MMMLU][mmmlutest] | GPQA S/V3600s，模板无CPU/MEM；MMMLU1CPU/2048MB/0GPU、S300/V60s、public。题目所需互联网未核实；matcher不调用judge。[配置][gpqaconfig] [MMMLU配置][mmmluconfig] |
| SimpleQA（Q/judged-answer） | question → `/workspace/answer.txt` | LLM将答案分 CORRECT/INCORRECT/NOT_ATTEMPTED，reward为是否正确；不是研究报告rubric。[judge][simplejudge] | 1CPU/2048MB，S3000/V600s；judge模型默认gpt-5-mini，API依赖；verifier现场pip。judge可重复性未核实。[配置][simpleconfig] [入口][simpletest] |
| GAIA（Q/tool-assisted-answer） | 多步任务/可选附件 → answer.txt；是否检索由任务决定 | **本地转换版**只是 lowercase+首尾空白规范化相等；不能把这称作已核实原生全部数字/列表匹配规则。[测试][gaiagrade] | S600/V300s；CPU/GPU与逐题联网需求未核实。[配置][gaiaconfig] |
| DABstep / BixBench（Q/data-analysis） | 数据分析 workspace → 答案；BixBench附 notebook/CLI 包装 | DABstep复制专门scorer，BixBench调用llm_judge；它们产出分析过程不意味着主评分是R。[DABstep生成器][dab] [DABstep scorer][dabscore] [Bix测试][bixtest] | DABstep S1800/V600s、1CPU；Bix2CPU/8192MB/0GPU、S3600/V600s、public且judge API。其余真实资源/稳定性未核实。[DAB配置][dabconfig] [Bix配置][bixconfig] |
| BIRD / Spider2-DBT / SpreadsheetBench（W/data-artifact） | SQL/DBT项目/电子表格 → answer.sql、项目变更、表格 | BIRD对同一数据库执行预测/参考SQL，比较结果set；Spider调用test_dbt；Spreadsheet独立evaluate。数据正确性不是报告judge。[BIRD][birdgrade] [DBT][dbttest] [表格][sheettest] | BIRD1CPU/4096MB、S3600/V1800s；DBT1CPU/2048MB/0GPU、S1800/V600s；表格1CPU/4096MB/0GPU、S/V600s。DBT/表格public；数据库固定性和整套确定性未实测。[BIRD配置][birdconfig] [DBT配置][dbtconfig] [表格配置][sheetconfig] |
| StrongReject / IneqMath（Q，评分profile不同） | 受限回答/数学证明 → 文本 | StrongReject是LLM rubric，但评的是回答：原始score越高表示有害请求完成程度越高，Harbor最终写入的reward却是`1−score`、越高越安全。空回答被当作拒答，正常路径reward=1；judge异常被吞成reward=0，必须另判validity。IneqMath入口已看到，详细证明judge未核实。[原始公式][stronggrade] [反转与异常][strongfinal] [IneqMath入口][ineqtest] | StrongReject1CPU/2048MB/0GPU，S600/V300s、public、非空回答需judge API；IneqMath S/V3600s。judge稳定性未核实。[Strong配置][strongconfig] [Ineq配置][ineqconfig] |
| BFCL / BFCL parity（Q/structured-call） | 函数schema + 请求 → result.json调用列表 | 本地转换器生成结构/参数检查；relevance只要求有效非空列表；未实际执行真实函数接口。[指令][bfclinstr] [生成器][bfcladapter] | 2CPU/4096MB、S/V300s；真实外部函数服务并非此合同需要；模型API和安装网络另计。原生全子集parity未核实。[配置][bfclconfig] |
| tau3-bench adapter（I/simulated-user） | CLI/MCP工具agent + tau3-runtime服务 + 模拟用户 → 有副作用的会话轨迹 | 本地目录名为tau3，但实现引用tau2 runtime，按domain重建task并evaluate_simulation，含可选NL assertions；不可混称所有tau版本等价。[配置][tauconfig] [evaluator][taueval] | 4CPU/8192MB，S3600/V300s；用户模型与NL-assertion模型可配置且需API；动态模型用户的确定性未核实。它未在本地80项registry中。[registry][registry] |
| TextArena adapter（I/text-game） | agent容器通过HTTP获取observation、提交action；game sidecar持有状态 | `reset(num_players=1, seed=42)`；终局close取得rewards，token保护result。不是本地已验证的多玩家竞技榜单。[server][textserver] | S3000/V600s；CPU/MEM/GPU未在模板规定；agent模型API另计。现有verifier把服务错误写0，接入需补validity，见第5节。[配置][textconfig] [评分][texttest] |
| CooperBench（W/cooperative） | 两个agent sidecar、各自workspace、通信/共享patch产物 → 联合patch | 等双方done，收日志、合并patch、跑feature验收；单个trial必须保存双方角色和merge证据。[verifier][cooptest] [sidecar生成][coopadapter] | 主模板2CPU/4096MB，agent/verifier默认1800s由adapter传入；sidecar资源应另计，整组实测未核实。[配置][coopconfig] [adapter][coopadapter] |
| MedAgentBench（I/stateful-service，暂定） | FHIR服务相关任务；verifier轮询服务并verify task_metadata | 服务依赖、验收入口已核实；完整动作schema、所有终局规则未核实，不能仅当医学QA。[测试][medtest] | 模板2CPU/4096MB、S/V参数化；服务网络可达必需，公网是否必需未核实。[配置][medconfig] |

下列补充条目进一步检验了类别边界。它们均是本地 Harbor 包装的合同，不能自动等同于原生单轮榜单协议：

| Benchmark / variant（建议类） | subject、输入/产物、scoring | 资源、网络与确定性 |
|---|---|---|
| FinanceAgent（Q/judged-answer） | CLI工作区中的金融问题→`answer.txt`；judge比较question/reference/prediction并输出CORRECT/INCORRECT，非开放报告rubric。[judge][financegrade] | 1CPU/2048MB，S3600/V600s；judge API必需于judge路径，solve搜索是否每题必需未核实；实际judge一致性未核实。[配置][financeconfig] |
| SATBench / ARC-AGI-2 / reasoning-gym（Q） | SAT取`solution.txt`最后一个[SAT]/[UNSAT]；ARC比较输出grid的每行每格；reasoning-gym按dataset params重建并调用`score_answer`，各子任务不必同一matcher。[SAT][satgrade] [ARC][arcgrade] [RG][rggrade] | SAT 1CPU/2048MB、S600/V120s；ARC 1CPU/1024MB/0GPU、时限参数化；RG 1CPU/512MB/0GPU、S120/V60s。ARC/RG允许public；比较逻辑无judge，完整离线与重复稳定性未核实。[SAT配置][satconfig] [ARC配置][arcconfig] [RG配置][rgconfig] |
| LawBench / PIXIU（Q/domain-NLP） | LawBench读answer.jsonl并按任务加载evaluation function；PIXIU含分类、QA、NER，分类保存pred/gold供跨样本F1/MCC聚合，单样本f1_approx只是accuracy，不是官方全局F1。[Law评分][lawgrade] [PIXIU指标][pixgrade] | Law 1CPU/2048MB、S/V3600s；PIXIU S/V600s、模板未声明硬件。子任务judge/互联网依赖需逐一核验，未核实。[Law配置][lawconfig] [PIXIU配置][pixconfig] |
| MMAU（Q/audio-answer） | 音频推理包装，交answer.txt；matcher要求包含正确答案全部tokens且不含错误选项的独有tokens。[matcher][mmaugrade] [任务标签][mmauconfig] | 1CPU/2048MB/0GPU、S600/V7200s、public；没有从matcher看到LLM judge；音频处理工具、数据下载与原生parity未核实。[配置][mmauconfig] |
| KUMO（I/query-game） | knowledge book + 候选truth + 可用actions；CLI向服务查询动作并收observations，最终交answer.txt。scorer精确匹配truth并记录actions_used/oracle_action_count；不是只凭最后文件就能复原求解过程的闭卷QA。[指令][kumoinstr] [CLI][kumocli] [评分][kumograde] | 1CPU/2048MB、S900/V120s，custom compose；指令称交互local/offline，模型API另计；动作上限是否被完整实施及server随机性未核实。[配置][kumoconfig] |
| CrustBench（W/build-test） | workspace中的Rust项目→修改代码；verifier清理构建缓存并执行cargo build/test --release；输入转换语义和全量原生测试对应关系未核实。[测试][crusttest] | 1CPU/2048MB、S1800/V120s；Cargo依赖网络与锁文件删除影响必须实测，确定性未核实。[配置][crustconfig] |
| CompileBench（W候选） | adapter列15个任务并从固定上游commit取task，然后重写资源字段；实际被引用任务的完整输入/产物/验收未在本地核实。[adapter][compileadapter] | S/V、CPU/MEM和联网从取回的task复制，不能从15个名称推导统一资源；运行与确定性未核实 |

**4．Asta 与 SandboxFusion 应按子任务拆分；agent 产品不能计为数据集**

Asta `v1.0.0.yml` 明列 validation/test 的子评测及 primary metric，还给 LitQA2 两个 lit 子项各0.5的macro权重；registry另包含code_diagnostics与demo。因而“Asta支持”必须落实为子任务、split、solver与metric，而不是给整个套件一个研究报告分数。[Asta套件定义][astaconfig] [任务注册][astareg]

| Asta 子任务 | 合同与评分（建议类） | 环境、资源、网络、确定性 |
|---|---|---|
| ScholarQA CS2 | 研究问题→带章节/引用/片段的报告；ingredient recall、precision与citation precision/recall经reducer组成global_avg，R；不是简单exact-match QA。[task][sqatask] | 可选Asta MCP/native search/report editor；scorer是远程模型，默认temperature0.5/top_p0.95；检索时间边界也入配置。task未给统一运行时/CPU/GPU预算，未核实。[task][sqatask] |
| LitQA2 FullText | question+choices含“Insufficient information”→选项；正确率与coverage/selective accuracy，Q。[实现][litqa] | 搜索工具可选，选项有shuffle；不能只固定模型seed而忽略选项排列。每题资源与离线等价性未核实。[实现][litqa] |
| PaperFindingBench / LitQA2 FullText Search | query→有序paper_id+evidence列表；specific/metadata/litqa2与semantic走不同分支；分别看adjusted_f1_micro_avg、recall_at_30，Q/retrieval。[实现][paperfinder] | 检索与证据核查网络依赖按具体工具；统一硬件与时限未核实。索引版本、日期过滤、top-k必须入指纹。[实现][paperfinder] |
| ArxivDIGESTables | 给定论文集合/表格要求→结构化表；模型unroll表格，再对target statements判断支持并算recall；Q/structured-synthesis，也可作为R的表格profile。[评分][arxivtask] | snippet_search限制allowed corpus IDs，scorer和unroller temperature0；两者API与搜索服务依赖。temperature0不等于已核实确定性。[实现][arxivtask] |
| DiscoveryBench | 数据+query→hypothesis/workflow；与gold用LLM计算HMS；Q/hypothesis-answer，不是任意开放研究报告。[实现][discovery] | Python session + Docker，公共sandbox 2CPU/48G、bridge；judge指定模型；S/V总预算未核实。[实现][discovery] [sandbox][astasandbox] |
| DS-1000 | 保留代码片段completion与原scorer，但Asta setup显式增加Python session；有反馈的版本需独立variant，不能直接按C原生单轮比较。[wrapper][astads] | Docker公共sandbox2CPU/48G；validation/test ID名单固定；模型API外的网络必要性未核实。[wrapper][astads] [sandbox][astasandbox] |
| CORE-Bench Hard / SUPER Expert | 科学代码执行/复现工作流；CORE wrapper与SUPER专用scorer；SUPER记录output_match/submitted/landmarks，W或Q-reproduction取决于所注册交付合同。[CORE][astacore] [SUPER][astasuper] | 有Docker sandbox；公共配置与task override需一起核对，真实峰值未核实；不能把source依赖配置当统一GPU需求。[sandbox][astasandbox] |
| E2E Bench / Hard | problem_description + 私有evaluation_rubric→结构化研究results（paper/code/artifacts等）；score_rubric，R。[实现][e2e] | Python session + Docker公共sandbox；rubric model独立，temperature0。当前分支允许skip_immediate_scoring并返回0同时记录skipped，导入时必须区分“待评”与有效0；完整端到端效果未核实。[实现][e2e] [sandbox][astasandbox] |
| code_diagnostics、demo | `evals/_registry.py`可定位注册入口；详细合同与正式benchmark地位**未核实**，不纳入已认证正式榜单。[注册][astareg] | 未核实；demo不得作正向benchmark校准证据 |

SandboxFusion 是**执行/数据接口组件**；它可以用作 C 类共享执行器，不应成为掩盖上游数据身份的中间 benchmark。其 `local.yaml` 将数据库设为none并从测试sample目录读取数据，所以“实现支持某dataset”不等于“本机具备全量dataset”。它同时把 `sandbox.isolation` 设为none、`cleanup_process`设为false；直接接入时必须核对实际部署配置，不能依据名字宣称已有Docker级隔离。[registry实现][sfregistry] [local配置][sflocal]

| SandboxFusion 家族 | 输入/产物/评分 | 资源、网络、确定性 |
|---|---|---|
| HumanEval / Shadow-HumanEval / 语言变体 / BigCodeBench | prompt或messages→completion→抽取代码+tests→run_code_in_sandbox；accepted来自RunStatus.Success，C。[接口][sfapi] [实现][sfhe] | HumanEval默认run20s；BigCodeBench分支60s；GPU未要求。编译/执行默认值分别由request控制；数据在本地时此评分路径无外部judge，公网隔离仍取决于部署。[实现][sfhe] [执行接口][sfrun] |
| MBPP | few-shot选择会改变展示哪些tests及执行哪些tests；completion先抽取，再拼setup/test；C。不能笼统写“所有测试均hidden”。[实现][sfmbpp] | 默认run20s；CPU/MEM未在dataset固定；同代码测试判定可重放，实际稳定性未核实。[实现][sfmbpp] |
| LiveCodeBench v1 | 从数据库test字段解码cases，抽取Python代码→沙箱执行；C。此版本ID与Harbor release_v6不是同一数据身份。[实现][sflcb] [registry配置][sflocal] | 默认每case6s，总timeout=min((timeout+1)×case数+5,160)s；无judge调用；完整case来源/隐蔽性和全量数据未核实。[实现][sflcb] |
| Code Contests / MultiPL-E / EvoEval / MBXP / HumanEvalDS / OODTest / MHPP / NaturalCodeBench | local registry有具体dataset ID与class映射；完整列表见local.yaml。除了前述已详查者，各自抽取/比较细节、全量数据与原生parity**未核实**，暂列C候选。[配置][sflocal] | 按语言runtime与TestConfig；不能把通用默认10s称为这些dataset的官方预算。[接口][sfrun] |
| CruxEval / CruxEval-X / RepoBench-C/P / PALMath / miniF2F Lean4 / VerilogEval | 注册代码显示不是全都“自然语言→Python函数”：存在代码理解、补全、数学、形式证明、硬件描述语言处理器。精确子类/评分细节**未核实**，接入前按Q或C合同再核验。[配置][sflocal] [处理器类型][sfapi] | 编译器/证明器/运行器版本必须声明（建议）；现有各项完整资源、网络、确定性未核实 |

| 用户指定的其他仓库/名称 | 本地核对结论 | 如何纳入 Orbit |
|---|---|---|
| EvoScientist | 有 `create_deep_agent`、MCP与subagent构建逻辑，是受测agent实现的证据；未找到本次可认证的独立固定benchmark任务/官方评分集合，后者**未核实**。[agent代码][evoscientist] | 登记为Method，按所跑W/Q/R/I任务供给接口；它内部多agent不自动形成“multi-agent benchmark” |
| open-science | package定位为research desktop，SDK封装runtime；独立benchmark集合**未核实**。[package][ospkg] [SDK][ossdk] | 可作为Method/runtime来源，不作为数据集行累计任务数 |
| openscience | CLI package与research/domain agent定义已核实；独立benchmark集合**未核实**。[package][openscipkg] [agent定义][opensciagent] | Method与工具权限配置，实验必须固定版本/skills/模型 |
| autosci | `run_scientist(task, workspace, …)`返回状态、response与trajectory report；这是求解器入口，独立benchmark集合**未核实**。[入口][autosci] | Method；不能将它在ResearchClawBench上的运行记录再算一个新benchmark |
| MLE-bench | 在指定范围的registry/adapter及任务实现搜索中未找到对应实现；ASI探索笔记提到MLE-bench Lite，但它不是该benchmark代码。[探索笔记][mlenote] [registry][registry] | **未核实**：subject、输入输出、评分、资源、runtime、network、determinism均不作事实断言；仅可暂列W/training待接入候选 |
| PaperBench | 指定范围仅检索到skills文档里的模型成绩表提及，未找到任务/评分实现；这不能支持PaperBench接入结论。[提及][papernote] [registry][registry] | **未核实**：完整合同与支持状态；不得拿ResearchCodeBench或ReplicationBench冒充PaperBench |

**5．现有实现揭示的接入风险与必须保留的偏差**

以下均是静态代码事实及其明确推论，未开展漏洞利用或运行验证。

| 观察 | 本地证据 | 对类别规范的要求（建议） |
|---|---|---|
| 一个数值reward不足以表示有效性 | TextArena请求result失败/缺reward时写0并exit0；SimpleQA缺ground_truth写0；MLGym evaluate.py失败会走penalty；TB-Science样例test.sh也把任意Python非零退出折成0。[TextArena][texttest] [SimpleQA][simplejudge] [MLGym][mlgymtest] [TB入口][tbtest] | 提供结构化scorer_status和failure证据；区分候选程序失败、参考资产缺失、执行器崩溃、judge失败。保留上游官方计分，但Orbit validity独立判定 |
| judge格式解析也可能把故障吞成正常错题 | SimpleQA响应提取不到A/B/C时默认C；RCB底层失败项可能写0和“Scoring failed.”，Orbit wrapper进一步检查failedItems；Asta E2E可有skipped=0。[SimpleQA][simplejudge] [RCB][rcbscore] [wrapper][rcb] [E2E][e2e] | 缺失或不符合judge schema不能当模型答错；缓存原始judge请求/响应/解析状态，对未评项标invalid或pending/unknown，不能补零伪造完成 |
| Harbor LCB 的“private test”字段可能暴露到solve镜像 | adapter将同一个`task.__dict__`写到tests/config.json与environment/tests/config.json；Dockerfile复制tests；final_test读取private_test_cases。[生成器][hlcb] [Dockerfile][hlcbdocker] [最终评分][hlcbfinal] | **静态推断**：若源记录含private字段，agent可读环境内该字段；本次未运行验证。需剥离或隔离后再认证hidden-test profile；“private”字段名本身不是访问控制 |
| 非二元reward不能统一解释为通过率或0–100分 | AlgoTune输出speedup；MLGym continuous reward相对baseline可负；Orbit Harbor读取reward时固定maxScore=1，通用score按100×score/maxScore显示。[AlgoTune][algograde] [MLGym][mlgymadapter] [Harbor读取][hreward] [metricValue][ometrics] | 必须声明native metric单位、方向、取值域、缩放与聚合；不能把2×speedup写成200%解决率；保留原值，不臆造有限maxScore |
| “全部是Docker容器”与当前实现不完全一致 | ASI solve/verify、LongDS与RCB judge均有`backend: process`；PTB solve/verify为容器spec。[ASI][asi] [LongDS][lds] [RCB][rcb] [PTB][ptb] | 直接接入规范应声明哪个进程拥有子容器、清理和资源；后续迁移到容器不能悄悄改变native runner语义；当前process隔离边界必须公开 |
| 默认校准假设过强 | calibrate要求empty==0、oracle==maxScore、多个seed分数严格相等、rescore严格相等；StrongReject空回答正常路径reward=1，是明确反例。[calibrate][calibrate] [StrongReject][strongfinal] | RCB/PTB没有通用oracle；训练/性能/LLM judge不适用统一精确相等；使用类别化fixture与容差/统计校准，并允许明确not_run |
| 同名数据经过包装后预算、样本和接口会变 | PTB verify固定limit100；ASI标non-official seed31415；LCB registry为100题抽样；Asta DS-1000加Python工具。[PTB][ptb] [ASI][asi] [registry][registry] [Asta DS][astads] | variant身份必须包含subset、tools、time、judge与score mode；这些成绩不得省略偏差称“官方全量” |
| 默认网络不能从容器存在与否推断 | Harbor有public/no-network/allowlist；Orbit对allowlist只有显式public降级选项；任务级mcp_servers和steps仍拒绝。[Harbor config][hcfg] [Orbit导入][harbor] | 默认不能降级网络或遗漏多轮；不能直接宣称tau3的MCP task可走现有Orbit Harbor零代码路径 |

**6．共用接入底座：所有类别只有一套执行、证据与结果协议（设计建议）**

保留 Orbit 现有 `tasks → solve → verify → score` adapter协议以及 Run/Trial/Outcome；category只是声明约束和共用profile选择，不生成第二个调度器、数据库、重试状态机或hub目录。当前设计明确daemon统一执行，Outcome保留execution/evaluation/cleanup；contracts中已有closed FailureKind、Episode、OfficialRule。[adapter协议][oprotocol] [Outcome契约][ocontract] [分类实现][oclassify]

每个**具体 benchmark/variant**直接登记在category下。可读取其原生数据、导入原生scorer、直接消费Harbor兼容任务目录；不要求先把它注册进Harbor、Asta或SandboxFusion hub。使用Harbor格式不等于“通过Harbor benchmark中转”；重包装若改变题目、反馈、权限或评分，则应有独立来源身份，例如EFE本身及Harbor-agentic LCB。**共享库是实现复用，benchmark identity是评测定义，二者分开。**

建议最小接入声明包含下列必填信息；字段名为示意，**不是已实现schema**：

| 维度 | 必填合同 |
|---|---|
| identity | upstream名称/revision/license、task id与数据digest、split/subset清单、variant、category/profile、scorer revision、适配代码revision；原生与包装名称分列 |
| subject | cli-workspace / completion / ordered-session / domain-tools；instruction/messages/attachments schema；允许工具、反馈次数、共享会话规则、模型/agent版本及skills配置；方法的内部subagent与环境模拟用户分列 |
| environment | image digest、初始文件/DB/assets摘要、只读/可写路径、service拓扑、每角色health/reset/stop/finalize/collect；process后端必须显式列出子进程/子容器所有权 |
| budgets | setup/solve/每turn/每call/finalize/verify独立上限；token/cost/test次数；wall-clock计时起止、暂停是否计时；CPU/RAM/GPU数与显存/磁盘/shm/网络按角色声明 |
| network | 安装下载、被测模型API、任务检索、judgeAPI、内部服务五种用途；各phase allowlist/禁网策略、缓存快照；任何放宽都进入deviations |
| submission | 唯一权威产物与schema；文件缺失/格式错误/空答案的合法计分规则；多轮完整性、排序、终止条件；patch基准commit、模型checkpoint格式、报告资产相对路径 |
| scorer | 原生入口/参数/版本/环境；测试和GT隔离；匹配规范、数值容差或rubric权重；LLM model/prompt/temperature/seed/retries/响应schema；不能把agent自行写出的score当权威 |
| result | 原始metric、单位、方向、范围、validity/failure/diagnostics、逐case/criterion/turn明细；缺项数量和expected count；score仅是可选展示投影，不替代native metric |
| evidence | producer、trust、sample/attempt/phase、文件hash与来源；agent产物和可信executor/service产物分开；敏感GT/judge凭据不进agent可读路径 |
| trajectory/review | 按category要求的view及原始文件；工具调用ID、角色、step/turn和时间；声明complete/truncated/environment-only等完整度，不能补造不存在的推理记录 |
| aggregation | 固定样本清单；task/turn/episode/candidate统计单位；官方错误/缺项/attempt规则；权重、micro/macro、pass@k等公式；并列Orbit valid-only，不跨benchmark乱平均 |
| calibration | 可运行正负fixture、empty的预期、oracle可用性、judge故障fixture、native对照样本及容差；清理测试、重评分测试；未覆盖的条目明确not_run |

建议统一生命周期为：`preflight → reserve roles → setup/reset/health → run subject → freeze/quiesce → finalize trusted state → collect/hash → verify → classify → publish report revision → cleanup confirmed → release lease`。离线W/Q/R/C可省去不适用的服务步骤；I与EFE live-sidecar必须在服务尚可读时先finalize。恢复时只重放幂等操作；非幂等工具动作必须有operation ID和查询，否则终止并保存“结果未知”的attempt。此建议沿用Orbit已记录的结束阶段与证据原则，但各bench的恢复正确性尚需校准。[生命周期设计][olifecycle] [非幂等操作约束][ointeraction]

**6.1．共同validity规则与闭合集映射**

当前代码的封闭集合实际为 `infra, agent_install, env_start, env_step, reset_failed, policy_start, policy_act, server_unreachable, call_watchdog, resume_failed, scorer_error, judge_unavailable, model_unavailable, budget_exceeded`，比设计文档简表多`infra/agent_install`；以contracts为准。当前取消/lost可为unknown；solve失败或普通超时仍可评分；solve容器OOM归budget_exceeded并保留但排除分数；verify超时/OOM为scorer_error。[契约][ocontract] [classify][oclassify]

| 事件 | 建议的处理，兼容现有Outcome三轴 |
|---|---|
| 模型给错答案、输出语法错、候选代码编译失败、测试不通过、无报告/无模型 | 若原生合同如此规定且执行器健康，valid低分/0分；它们是能力结果，不借invalid逃避 |
| 候选代码超过题目规定CPU/内存/时间限制 | 原生判为TLE/MLE则记valid失败；**与Orbit solve/verify容器整体OOM是不同层**。外层资源不足仍依当前分类记invalid/budget_exceeded或scorer_error；记录两层预算 |
| solve达到声明时间限制 | 冻结可评分产物后照常verify；是否扣分/0由任务合同决定；不可统一把超时都删分 |
| 镜像/数据/reference不存在、错误初始状态、service无法启动 | invalid；依据失败阶段映射infra/env_start/reset_failed，保留具体错误与资产digest |
| agent安装失败；没有一次成功模型回复且可信日志明确认证/模型不可用 | invalid/agent_install 或 model_unavailable；工具输出中出现类似文本不是证据，沿用现有可信会话判断 |
| executor/verifier崩溃、输出缺失/NaN/schema不合法、评分项覆盖不足 | invalid/scorer_error；若只是候选答案格式错误且scorer完成，则valid0；必须看故障producer |
| judge API失败、超出允许retry、缺少或无法解析裁决 | invalid/judge_unavailable（或解析器内部故障scorer_error）；不得把失败裁决填零或仅平均成功子项 |
| 非幂等动作失联、环境步状态无法确认、会话不能恢复 | invalid/env_step、server_unreachable、call_watchdog、resume_failed之一；事件标记结果未知；不盲目重发动作 |
| 人工取消、Run lost、尚未评分 | 按当前unknown语义；不伪装成能力0分。官方统计如果把缺项当失败，单独在official列按规则计入 |
| 证据hash/签名或身份不匹配 | invalid/scorer_error或infra并明确detail；不新增无边界failure字符串；不因视频缺失而否定已有可信数值裁决，除非视频本身是该scorer必需输入 |
| cleanup失败 | 单独cleanup=failed并持有租约；已有评分是否valid按证据完整性决定，不能简单把cleanup失败等价于模型答错 |

以上表格是新增类别规范的**建议**；其中现有执行分类的事实依据为[classify][oclassify]，不能把所有建议写成当前已支持行为。

**6.2．证据、轨迹和review共用格式（建议）**

建议每trial一个不可变原始证据目录，再给轻量index；至少标识 `benchmark/task/variant/attempt/role/turn/step/producer`。Agent文本、patch、报告、模型都标self-reported；executor测试结果、simulator状态、judge原始响应标独立producer。judge是模型裁决，不等同数值真值。保存hash只能证明采集后未变，不能单独证明agent无法伪造其来源。

Harbor已有ATIF trajectory与subagent引用结构；Orbit也有trajectory契约，但统一导入全部原生日志尚未完成。建议复用其事件/媒体索引，保留native raw日志，避免为了统一而丢弃未识别字段。没有必要要求每类都保存视频。[Harbor ATIF模型][atif] [Orbit轨迹契约][otrajectory] [设计中完成度边界][otrajectorydesign]

**7．每类别精确接入规范（均为设计建议；与第6节共用合同叠加）**

| 维度 | W：工作区工程任务 |
|---|---|
| subject interface | 给定instruction+项目/数据快照，Agent在指定workspace内自主命令/编辑；产物类型枚举patch、files、checkpoint、service-state。是否可反复跑公开测试、可安装依赖、可用搜索必须写明；不额外提供隐藏测试反馈 |
| environment/lifecycle | 每sample新工作区；保留base commit、补丁应用规则、只读测试/GT。默认在新verify环境只导入声明的产物；若原生要求shared verifier，用可信监督保留环境状态并标注风险。训练、数据库、cooperative、live-sidecar是模块化profile |
| scoring source / judge validity | 原测试/validator/script为权威；数值任务保存逐metric与threshold；performance保存baseline/候选计时及硬件；混合judge如ASI须保存全部gate与子项、权重和错误标志。部分judge失效不静默按其他子项重分配权重 |
| invalid rules | 参考test或data缺失、执行器崩溃、无法恢复正确base、训练模型无法读取且原因属验证环境→invalid；candidate自身编译失败/不达metric→valid失败。联合任务缺一个agent时区分agent主动未交付与sidecar未启动 |
| evidence/review | base SHA+diff、完整提交文件/模型hash、测试列表及stdout/stderr/退出码、测量脚本结果；代码review提供diff/终端，训练提供学习曲线和checkpoint信息；service-state必须来自服务，不接受agent伪写状态文件 |
| trajectory | CLI会话与工具调用；训练子进程关联；cooperative各agent独立session+消息因果链+merge；live-sidecar的sim journal/动作与CLI工具调用关联，不用保存脚本代替已执行动作 |
| calibration | empty+已知正确/错误patch或产物；基础环境故障fixture；正确但慢的解与数值边界；训练用固定checkpoint、冻结预测进行评分校准，不假装它是自动求解oracle；性能计时重复采样并给预设容差 |
| aggregation | 测试resolved率、数值metric、speedup、baseline delta分别原样；SWT的测试发现能力、CooperBench联合成功率不能换成普通pass率；种子先按task聚类。超时但有结果的尝试遵守原任务预算 |
| resources | 每角色CPU/RAM/GPU/显存/磁盘，训练solve与推理verify分别申请；performance需要型号/线程/频率/负载约束；并发sidecar总资源整组准入；模型与数据使用只读缓存 |

W/live-sidecar只在具体benchmark确实要求时启用：EFE standard冻结动作→服务finalize在线终局→采集可信证据→独立评分；不能重跑agent脚本模拟“原轨迹”。native VLA需自己的observation/action profile，不通过这个CLI合同冒充被测policy。这一选择依据前述[任务指令][efe]与[policy协议][vlaproto]，所有实现新增项仍是建议。

| 维度 | Q：答案与检索问答 |
|---|---|
| subject interface | 单题prompt/messages/附件或有序turn数组→typed answer；声明text、choice、numeric、JSON、ranked-list、function-call-list。工具为none/calculator/python/search等显式清单；CLI只是承载方式，不能默许所有工具 |
| environment/lifecycle | 单题答案可轻量进程/容器执行；需要计算/检索时提供对应服务；ordered-session保留同一workspace及上下文，按协议显式resume，下一轮输入是否依赖先前答案固定声明 |
| scoring source / judge validity | 严格规定提取、Unicode/空白/大小写规范化、绝对/相对容差、顺序/集合语义、拒答；judge需要question/reference/prediction三元组及模型prompt版本；BFCL保持category专用参数比较，不私自执行函数 |
| invalid rules | 被测答案缺失/格式错按原规则valid0；task reference损坏、judge不可用、turn丢失/重排、服务数据未准备好invalid；长会话部分完成的计分策略预先声明，不能以成功轮数替代预期轮数 |
| evidence/review | 原始回答、解析后值、reference的受控引用、matcher路径与逐轮裁决；检索题还保存查询、索引/日期、返回文档ID与证据片段；UI显示答案对照、命中/拒答和逐轮结果 |
| trajectory | 单题可只有request/response；tool-assisted记录工具；ordered-session记录turn ID/时间/上下文hash与session继承。动态模拟用户不能伪装成固定turn任务 |
| calibration | 标准答案、拒答、近义表述、数值边界、畸形JSON、空答案、缺reference、judge坏响应；matcher期望精确；LLM correctness judge用冻结样本集检验一致性与分歧，不强求每次bitwise分数相同 |
| aggregation | choice accuracy、selective accuracy/coverage、answer F1、retrieval recall@k分别声明；LongDS先任务内平均turn再跨task；各题turn数不同不能直接混在一个分母；pass@k另列attempt规则 |
| resources | 无工具与有工具预算分开；API并发/速率/token上限属于资源；网络用途限制到检索和模型/评分服务，不能用同一个boolean掩盖开放web与冻结语料的差异 |

| 维度 | R：开放研究报告 |
|---|---|
| subject interface | 研究任务+可见文献/数据/约束→报告、图表、可执行代码、结果表和引用证据；文件/JSON表示均可，输入输出schema固定。任务rubric中可见与隐藏部分分开声明 |
| environment/lifecycle | 持久workspace执行研究；结束时冻结report与assets，解析全部相对路径和引用；judge在独立phase只读证据。内部修订若属于受测method，计入同一预算并保留版本，不能由评分器悄悄帮助改稿 |
| scoring source / judge validity | 原生rubric ID、全文、类型、weight、scale、reference图/文本、prompt/model版本；保留每项原始响应、解析值、reasoning、token/cost/error；LLM judge不是一次test.sh退出码。RCB enhanced/official、ScholarQA各metric必须独立身份 |
| invalid rules | 无报告/空稿按原规则valid0；judge失败或漏项、参考图丢失、资产收集不完整导致无法评分invalid；不得只平均成功判分的项；skipped scoring不能进入有效分母 |
| evidence/review | 报告和图像并排、逐criterion证据位置/分数/理由、引用与支持片段；实验结果必须有原始产物链接。记录judge实际读到的文本截断范围，不能只存完整报告然后声称judge看过全部 |
| trajectory | 研究工具/实验/检索轨迹与最终证据关联；judge轨迹单独role，避免把judge产出的理由写成agent推理；多次judge为同一artifact的测量重复 |
| calibration | 无oracle时用冻结报告阶梯（空稿/不相关/部分支持/已知强报告）、人为缺图/假引用/不可复现证据、judge断网与格式错；人工抽审或原生runner对照；预先设权重和容差，不为“校准通过”修改rubric |
| aggregation | rubric权重合成与多次judge均值分层，报告judge spread；题目均值和跨题CI与judge方差分开；不要把重复judge当新增任务，也不把50分参考刻度改称成功率 |
| resources | 研究solve可CPU/GPU，judge可远程API/本地模型；阅读长报告、视觉judge的context/图片数量、并发与花费独立限额；联网检索按可重放缓存/开放web分别登记 |

| 维度 | C：一次性代码生成 |
|---|---|
| subject interface | 固定prompt/messages（含few-shot/语言/函数签名）→一个原始completion；生成阶段不暴露测试结果、不自主试跑；若允许debug/revise，另登记W或明确的feedback variant |
| environment/lifecycle | generation与trusted evaluation解耦；每candidate独立干净sandbox，固定编译器/依赖；禁止跨candidate进程/文件污染，结束强制清子进程；共享executor池也必须有reset证明 |
| scoring source / judge validity | 固定代码抽取策略、stop tokens、prefix拼接、main wrapper、测试集版本；保存编译和逐case运行状态；accepted由可信runner生成。是否所有测试hidden按dataset事实声明，不笼统承诺 |
| invalid rules | 抽取不到代码、语法错、WA、题目层TLE/MLE按原生规则valid失败；executor服务故障、编译器缺失、test资产损坏、外层容器资源误配invalid；不能把RunStatus的所有失败都映射同一有效0 |
| evidence/review | 原始completion、抽取代码、实际执行完整代码、测试版本hash、每case状态与时间、编译stderr；review给代码/测试面板，正常不需要整套workspace diff |
| trajectory | generation request/response与采样参数；executor events单独role。记录candidate index与prompt hash，不能将多候选压成一个无法复核的accepted |
| calibration | canonical正确代码、语法错误、超时、错误答案、污染后继candidate、不同语言、代码围栏抽取歧义；数据与executor ready前不接受样本；gold/reference不得流入generation |
| aggregation | 保留题目n个独立样本中c个通过；只有预先约定并满足采样条件才计算pass@k=1−C(n−c,k)/C(n,k)，n<k标不可计算；基础设施retry不能当新candidate或挑最好样本 |
| resources | compilation/run分开deadline与内存；CPU和磁盘小额配额按语言测量；GPU仅在明确CUDA/torch任务profile下申请。SandboxFusion的默认isolation=none不能直接作为生产profile |

| 维度 | I：状态型工具交互 |
|---|---|
| subject interface | 域schema、初始observation/用户消息→工具调用/动作/回复；保持原生状态机、角色、turn/step预算与结束信号。禁止把原本动态会话改成一次最终答案来评 |
| environment/lifecycle | 先启动并reset领域服务、DB、模拟用户/对手；被测Agent与用户模型凭据隔离；每sample独占状态。动作停止后先落盘终局与事件再关服务；恢复须核对state hash和operation ID |
| scoring source / judge validity | 环境终局、工具状态变化、预期动作、policy规则与NL assertions；按上游组合方式保留全部子分数。模拟用户输出是环境输入，用户模型故障属于环境失败，不是受测agent能力失败 |
| invalid rules | user model不可用、DB reset失败、服务断连、未知是否已执行动作、关键轨迹丢失invalid；合法动作导致输局、无效动作被环境正常拒绝、任务预算耗尽按原生规则valid失败 |
| evidence/review | 带role/turn/call ID的对话、工具参数与返回、状态摘要、终止原因、可信reward；TextArena游戏视图、tau对话/动作与业务状态diff，agent final answer不能覆盖环境判决 |
| trajectory | 全部参与者统一时间/因果序列；模型user和rule user分开；step重试不得产生双写；role与task身份齐全，不能把环境的模型成本算作被测模型成本 |
| calibration | 固定脚本动作/对话正例、正常失败、非法动作、动态user固定响应fixture、重复请求、断线、服务终止；有随机用户时用冻结用户轨迹先验分数，再做多seed原生对照 |
| aggregation | 原生任务成功率/episode reward及完整性；任务重复pass@k与基础设施retry区分；用户seed/对手版本分层；多角色联合任务一份sample，不按角色虚增样本数 |
| resources | agent、user/对手模型、工具服务与DB按角色预算和health；内部服务网络与外部模型网络分开；实时deadline与每call watchdog分开。不要把单player TextArena扩称multi-agent支持 |

**8．Harbor 已覆盖什么；类别规范必须补什么**

| 项目 | Harbor本地实现 / Orbit当前支持 | 类别规范要增加的语义 |
|---|---|---|
| 任务目录与运行入口 | TaskConfig具有agent/verifier/environment/solution/artifacts，verifier运行tests并读reward；可直接消费这种任务格式。[模型][hcfg] [verifier][hverifier] | subject接口、可见信息/工具权限、交付类型、原生variant身份、反馈次数；把QA写成answer.txt不自动固定single-shot协议 |
| 容器资源和网络 | CPU/RAM/storage/GPU/gpu_types/TPU、network_mode、MCP、healthcheck有模型；shared/separate verifier、collect hook也有。[模型][hcfg] | 各角色总预算、phase deadline、evidence trust与reset正确性；格式字段存在不等于Orbit已执行全部字段 |
| Orbit Harbor导入 | 有image/compose/services/artifact/shared-after/separate路径；unsupportedSettings明确拒绝steps、task级mcp_servers/skills_dir/healthcheck等；allowlist要拒绝或显式public偏差。[实现][harbor] | 每benchmark preflight能力验证；不能把“能转成task.toml”作为自动认证；tau3需要补MCP等能力或直接native接入 |
| reward | Harbor解析reward.txt/json并拒绝缺失、非数值、非有限数；Orbit额外识别infra_error/grader_error，但主体仍选单reward/maxScore1。[Harbor verifier][hverifier] [Orbit读取][hreward] | source-aware validity、judge覆盖度、非二元metric与方向、score component、missingness；脚本吞错写0不会被简单读取发现 |
| 轨迹 | Harbor有ATIF步骤、session/subagent引用；Orbit保留自己的trajectory契约与部分导入。[ATIF][atif] [Orbit][otrajectory] | 本track的answer/criterion/candidate/role级关联、完整度、引用证据、训练/测试事件、原生rescore材料 |
| 聚合 | Orbit当前metric是先任务内seed均值再跨task均值；OfficialRule只声明errors/exclude或fail、sample/task单位和单metric。[metrics][ometrics] [OfficialRule][ocontract] | pass@k、检索micro-F1、Asta分组权重、性能统计、rubric/judge重复层等必须明确扩展或保留原生summary并校验；不能声称现有mean配置覆盖任意官方统计 |
| 校准 | 现有calibrate确有empty/oracle、重复seed、cleanup、rescore检查。[实现][calibrate] | 允许oracle不存在、empty不是0、无有限满分、随机judge/训练；类别化fixtures、native parity与统计容差 |

这意味着L0/L1/L2仍可作为**实现方式**，与五类正交：C也可以用Harbor目录承载执行器；R也可能用简单manifest；I常需服务桥，但不因此为每个hub另造完整规范。当前设计§9.14“优先跟随hub”的产品策略需要按本需求修正为“按category直接登记具体benchmark，复用现有format/SDK”。这是一项**建议的设计变更**，不是说当前代码已经采取了它。[现行接入层设计][ointegration]

**9．落地顺序与验收（建议）**

1. 先做共用identity、submission、scorer-status/producer、metric-domain、calibration fixtures字段及preflight，不先增加benchmark目录层级。迁移必须保留旧trial重评材料和结果修订。
2. 用本地证据清楚且合同不同的样本覆盖五类：W选SWE-bench或TB-Science；Q选GPQA与LongDS；R选RCB与ScholarQA；C选SandboxFusion HumanEval/MBPP；I选tau3和TextArena。每类至少完成正常正负例、基础设施故障和rescore/cleanup，不只跑empty。
3. 再覆盖会暴露共用层缺口的profile：W训练/PTB、performance/AlgoTune、mixed-judge/ASI、cooperative/CooperBench、live-sidecar/EFE。它们复用资源和证据模块，不再扩成按领域划分的新大类。
4. 对每个具体benchmark发布三份可核对数据（可在同一catalog条目内）：静态支持清单及拒绝原因、校准样本/条件/结果、与原生runner对照及deviations。旧catalog的“adapter tests”不能替代真运行校准；文档记录亦须保留其原口径。[catalog口径][catalog]
5. MLE-bench、PaperBench、registry-only项目待拿到直接源码和任务资产后再确定合同。线上Harbor registry与本地JSON差异、完整训练benchmark数据、所有judge重复性、GPU可达性、原生parity均列为**未核实**，不使用别的benchmark近似替代。

下列附表把“找到什么”完整展开；它们是覆盖清单，不是把每个条目认证为Orbit可运行。

**附表 A．本地 Harbor registry 的全部条目**

计数方法：对registry.json顶层数组逐项计算len(tasks)；未去重。每行链接定位相应name/version记录，重复name的不同版本使用各自起始行号。类名是本文建议，仅表示已检查实现所支持的主要合同；U表示本次仅确认登记记录存在，**subject、环境、输入、产物、评分、运行时/资源、联网必要性、确定性均未核实**。正文说明过的条目仍以其明确的未核实范围为准。registry里的任务通常是git引用；本地adapter模板与该外部已生成payload是否完全一致，本次统一未核实。

| # | 数据集@版本及registry证据 | task引用数 | 建议类别 / 核验边界 |
|---|---|---:|---|
| 1 | [aider-polyglot@1.0](harbor/registry.json:3) | 225 | W；见正文对应variant说明 |
| 2 | [aime@1.0](harbor/registry.json:1360) | 60 | Q；见正文对应variant说明 |
| 3 | [algotune@1.0](harbor/registry.json:1727) | 154 | W；见正文对应variant说明 |
| 4 | [arc_agi_2@1.0](harbor/registry.json:2658) | 167 | Q；见正文对应variant说明 |
| 5 | [autocodebench@lite200](harbor/registry.json:3667) | 200 | W；见正文对应variant说明 |
| 6 | [binary-audit@1.0](harbor/registry.json:4874) | 46 | U |
| 7 | [bixbench@1.5](harbor/registry.json:5157) | 205 | Q；见正文对应variant说明 |
| 8 | [bixbench-cli@1.5](harbor/registry.json:6394) | 205 | Q；见正文对应variant说明 |
| 9 | [codepde@1.0](harbor/registry.json:7631) | 5 | W；见正文对应variant说明 |
| 10 | [compilebench@1.0](harbor/registry.json:7668) | 15 | W候选；取回后的任务payload未核实 |
| 11 | [cooperbench@1.0](harbor/registry.json:7765) | 652 | W；见正文对应variant说明 |
| 12 | [crustbench@1.0](harbor/registry.json:11684) | 100 | W；见正文对应variant说明 |
| 13 | [dabstep@1.0](harbor/registry.json:12291) | 450 | Q；见正文对应variant说明 |
| 14 | [ds-1000@head](harbor/registry.json:14998) | 1,000 | W；见正文对应variant说明 |
| 15 | [evoeval@1.0](harbor/registry.json:21005) | 100 | W；见正文对应variant说明 |
| 16 | [gaia@1.0](harbor/registry.json:21612) | 165 | Q；见正文对应variant说明 |
| 17 | [gpqa-diamond@1.0](harbor/registry.json:22609) | 198 | Q；见正文对应variant说明 |
| 18 | [hello-world@1.0](harbor/registry.json:23804) | 1 | U |
| 19 | [humanevalfix@1.0](harbor/registry.json:23817) | 164 | W；见正文对应variant说明 |
| 20 | [ineqmath@1.0](harbor/registry.json:24808) | 100 | Q；见正文对应variant说明 |
| 21 | [mmmlu@parity](harbor/registry.json:25415) | 150 | Q；见正文对应variant说明 |
| 22 | [lawbench@1.0](harbor/registry.json:26322) | 1,000 | Q；见正文对应variant说明 |
| 23 | [livecodebench@6.0](harbor/registry.json:32329) | 100 | W；见正文对应variant说明 |
| 24 | [mlgym-bench@1.0](harbor/registry.json:32936) | 12 | W；见正文对应variant说明 |
| 25 | [mmau@1.0](harbor/registry.json:33015) | 1,000 | Q；见正文对应variant说明 |
| 26 | [otel-bench@1.0](harbor/registry.json:39022) | 26 | U |
| 27 | [reasoning-gym-easy@parity](harbor/registry.json:39185) | 288 | Q；见正文对应variant说明 |
| 28 | [reasoning-gym-hard@parity](harbor/registry.json:40920) | 288 | Q；见正文对应variant说明 |
| 29 | [replicationbench@1.0](harbor/registry.json:42655) | 90 | Q；见正文对应variant说明 |
| 30 | [researchcodebench@1.0](harbor/registry.json:43202) | 212 | W；见正文对应variant说明 |
| 31 | [rexbench@1.0](harbor/registry.json:44481) | 2 | W；见正文对应variant说明 |
| 32 | [simpleqa@1.0](harbor/registry.json:44500) | 4,326 | Q；见正文对应variant说明 |
| 33 | [sldbench@1.0](harbor/registry.json:70463) | 8 | W；见正文对应variant说明 |
| 34 | [spider2-dbt@1.0](harbor/registry.json:70518) | 64 | W；见正文对应variant说明 |
| 35 | [strongreject@parity](harbor/registry.json:70909) | 150 | Q；见正文对应variant说明 |
| 36 | [swe-gen-js@1.0](harbor/registry.json:71816) | 1,000 | U |
| 37 | [swe-lancer-diamond@all](harbor/registry.json:77823) | 463 | W+Q；IC/manager混合，不可合并契约 |
| 38 | [swe-lancer-diamond@ic](harbor/registry.json:80608) | 198 | W；IC |
| 39 | [swe-lancer-diamond@manager](harbor/registry.json:81803) | 265 | Q；proposal选择 |
| 40 | [swebench-verified@1.0](harbor/registry.json:83400) | 500 | W；见正文对应variant说明 |
| 41 | [swebenchpro@1.0](harbor/registry.json:86407) | 731 | W；见正文对应variant说明 |
| 42 | [swesmith@1.0](harbor/registry.json:90800) | 100 | W；见正文对应variant说明 |
| 43 | [swtbench-verified@1.0](harbor/registry.json:91407) | 433 | W；见正文对应variant说明 |
| 44 | [terminal-bench@2.0](harbor/registry.json:94012) | 89 | W候选；题目payload未核实 |
| 45 | [terminal-bench-pro@1.0](harbor/registry.json:94553) | 200 | W候选；题目payload未核实 |
| 46 | [terminal-bench-sample@2.0](harbor/registry.json:95760) | 10 | W候选；题目payload未核实 |
| 47 | [usaco@2.0](harbor/registry.json:95827) | 304 | W；见正文对应variant说明 |
| 48 | [bird-bench@parity](harbor/registry.json:97658) | 150 | W；见正文对应variant说明 |
| 49 | [vmax-tasks@1.0](harbor/registry.json:98565) | 1,043 | U |
| 50 | [seta-env@1.0](harbor/registry.json:104830) | 1,376 | U |
| 51 | [code-contests@1.0](harbor/registry.json:113093) | 9,644 | U |
| 52 | [openthoughts-tblite@2.0](harbor/registry.json:170964) | 100 | U |
| 53 | [kumo@parity](harbor/registry.json:171571) | 212 | I；见正文对应variant说明 |
| 54 | [kumo@1.0](harbor/registry.json:172850) | 5,300 | I；见正文对应variant说明 |
| 55 | [kumo@easy](harbor/registry.json:204657) | 5,050 | I；见正文对应variant说明 |
| 56 | [kumo@hard](harbor/registry.json:234964) | 250 | I；见正文对应variant说明 |
| 57 | [termigen-environments@1.0](harbor/registry.json:236471) | 3,566 | U |
| 58 | [bigcodebench-hard-complete@1.0.0](harbor/registry.json:257874) | 145 | W；见正文对应variant说明 |
| 59 | [financeagent@public](harbor/registry.json:258751) | 50 | Q；见正文对应variant说明 |
| 60 | [satbench@1.0](harbor/registry.json:259058) | 2,100 | Q；见正文对应variant说明 |
| 61 | [spreadsheetbench-verified@1.0](harbor/registry.json:271665) | 400 | W；见正文对应variant说明 |
| 62 | [labbench@1.0](harbor/registry.json:274072) | 181 | U |
| 63 | [bfcl@1.0](harbor/registry.json:275165) | 3,641 | Q；见正文对应variant说明 |
| 64 | [bfcl_parity@1.0](harbor/registry.json:297018) | 123 | Q；见正文对应variant说明 |
| 65 | [qcircuitbench@1.0](harbor/registry.json:297763) | 28 | W；见正文对应variant说明 |
| 66 | [quixbugs@1.0](harbor/registry.json:297938) | 80 | W；见正文对应variant说明 |
| 67 | [deveval@1.0](harbor/registry.json:298425) | 63 | U |
| 68 | [medagentbench@1.0](harbor/registry.json:298810) | 300 | I；见正文对应variant说明 |
| 69 | [pixiu@parity](harbor/registry.json:300617) | 435 | Q；见正文对应variant说明 |
| 70 | [ade-bench@1.0](harbor/registry.json:303234) | 48 | U |
| 71 | [ml-dev-bench@1.0](harbor/registry.json:303529) | 33 | W；见正文对应variant说明 |
| 72 | [featurebench-lite@1.0](harbor/registry.json:303734) | 30 | W；见正文对应variant说明 |
| 73 | [featurebench@1.0](harbor/registry.json:303921) | 200 | W；见正文对应variant说明 |
| 74 | [featurebench-modal@1.0](harbor/registry.json:305128) | 200 | W；见正文对应variant说明 |
| 75 | [featurebench-lite-modal@1.0](harbor/registry.json:306335) | 30 | W；见正文对应variant说明 |
| 76 | [swebench_multilingual@1.0](harbor/registry.json:306522) | 300 | W；见正文对应variant说明 |
| 77 | [scale-ai/swe-atlas-qna@1.0](harbor/registry.json:308329) | 124 | U |
| 78 | [scale-ai/swe-atlas-tw@1.0](harbor/registry.json:309080) | 90 | U |
| 79 | [legacy-bench@1.0](harbor/registry.json:309627) | 10 | U |
| 80 | [gso@1.0](harbor/registry.json:309694) | 102 | W；见正文对应variant说明 |

**附表 B．Harbor 本地 adapter 目录全量索引**

以下85个目录均位于harbor/adapters/；每行给出实际存在的adapter源码入口，个别目录给README入口。这个表只证明本地有相应文件，**不证明每个转换器已运行、数据已下载、全功能已检查或存在对应registry记录**。正文未详述的条目，其类别、subject、输入输出、scoring、资源、联网和确定性均未核实；超出本track的条目也只保留检索记录。

| 目录 | 本地入口证据 |
|---|---|
| aa-lcr | [adapters/aa-lcr/adapter.py](harbor/adapters/aa-lcr/adapter.py:1) |
| abc-bench | [adapters/abc-bench/src/abc_bench/adapter.py](harbor/adapters/abc-bench/src/abc_bench/adapter.py:1) |
| ace-bench | [adapters/ace-bench/adapter.py](harbor/adapters/ace-bench/adapter.py:1) |
| adebench | [adapters/adebench/src/adebench/adapter.py](harbor/adapters/adebench/src/adebench/adapter.py:1) |
| aider_polyglot | [adapters/aider_polyglot/src/aider_polyglot/adapter.py](harbor/adapters/aider_polyglot/src/aider_polyglot/adapter.py:1) |
| aime | [adapters/aime/src/aime/adapter.py](harbor/adapters/aime/src/aime/adapter.py:1) |
| algotune | [adapters/algotune/src/algotune/adapter.py](harbor/adapters/algotune/src/algotune/adapter.py:1) |
| arc_agi_2 | [adapters/arc_agi_2/src/arc_agi_2/adapter.py](harbor/adapters/arc_agi_2/src/arc_agi_2/adapter.py:1) |
| autocodebench | [adapters/autocodebench/src/autocodebench/adapter.py](harbor/adapters/autocodebench/src/autocodebench/adapter.py:1) |
| bfcl | [adapters/bfcl/src/bfcl_adapter/adapter.py](harbor/adapters/bfcl/src/bfcl_adapter/adapter.py:1) |
| bigcodebench_hard | [adapters/bigcodebench_hard/src/bigcodebench_hard/adapter.py](harbor/adapters/bigcodebench_hard/src/bigcodebench_hard/adapter.py:1) |
| bird_bench | [adapters/bird_bench/src/bird_bench/adapter.py](harbor/adapters/bird_bench/src/bird_bench/adapter.py:1) |
| bixbench | [adapters/bixbench/src/bixbench/adapter.py](harbor/adapters/bixbench/src/bixbench/adapter.py:1) |
| clbench | [adapters/clbench/src/clbench/adapter.py](harbor/adapters/clbench/src/clbench/adapter.py:1) |
| codepde | [adapters/codepde/src/codepde/adapter.py](harbor/adapters/codepde/src/codepde/adapter.py:1) |
| compilebench | [adapters/compilebench/src/compilebench/adapter.py](harbor/adapters/compilebench/src/compilebench/adapter.py:1) |
| cooperbench | [adapters/cooperbench/src/cooperbench/adapter.py](harbor/adapters/cooperbench/src/cooperbench/adapter.py:1) |
| crmarena | [adapters/crmarena/adapter.py](harbor/adapters/crmarena/adapter.py:1) |
| crustbench | [adapters/crustbench/adapter.py](harbor/adapters/crustbench/adapter.py:1) |
| cybergym | [adapters/cybergym/adapter.py](harbor/adapters/cybergym/adapter.py:1) |
| dabstep | [adapters/dabstep/adapter.py](harbor/adapters/dabstep/adapter.py:1) |
| dacode | [adapters/dacode/adapter.py](harbor/adapters/dacode/adapter.py:1) |
| deepsynth | [adapters/deepsynth/src/deepsynth/adapter.py](harbor/adapters/deepsynth/src/deepsynth/adapter.py:1) |
| deveval | [adapters/deveval/adapter.py](harbor/adapters/deveval/adapter.py:1) |
| devopsgym | [adapters/devopsgym/adapter.py](harbor/adapters/devopsgym/adapter.py:1) |
| ds1000 | [adapters/ds1000/adapter.py](harbor/adapters/ds1000/adapter.py:1) |
| evoeval | [adapters/evoeval/adapter.py](harbor/adapters/evoeval/adapter.py:1) |
| featbench | [adapters/featbench/src/featbench/adapter.py](harbor/adapters/featbench/src/featbench/adapter.py:1) |
| featurebench | [adapters/featurebench/adapter.py](harbor/adapters/featurebench/adapter.py:1) |
| financeagent | [adapters/financeagent/adapter.py](harbor/adapters/financeagent/adapter.py:1) |
| frontier-cs-algorithm | [adapters/frontier-cs-algorithm/src/frontier_cs_algorithm/adapter.py](harbor/adapters/frontier-cs-algorithm/src/frontier_cs_algorithm/adapter.py:1) |
| gaia | [adapters/gaia/adapter.py](harbor/adapters/gaia/adapter.py:1) |
| gaia2 | [adapters/gaia2/adapter.py](harbor/adapters/gaia2/adapter.py:1) |
| gdb | [adapters/gdb/src/gdb_adapter/adapter.py](harbor/adapters/gdb/src/gdb_adapter/adapter.py:1) |
| gpqa-diamond | [adapters/gpqa-diamond/adapter.py](harbor/adapters/gpqa-diamond/adapter.py:1) |
| gso | [adapters/gso/adapter.py](harbor/adapters/gso/adapter.py:1) |
| hle | [adapters/hle/src/hle/adapter.py](harbor/adapters/hle/src/hle/adapter.py:1) |
| humanevalfix | [adapters/humanevalfix/adapter.py](harbor/adapters/humanevalfix/adapter.py:1) |
| ineqmath | [adapters/ineqmath/adapter.py](harbor/adapters/ineqmath/adapter.py:1) |
| kramabench | [adapters/kramabench/adapter.py](harbor/adapters/kramabench/adapter.py:1) |
| kumo | [adapters/kumo/adapter.py](harbor/adapters/kumo/adapter.py:1) |
| labbench | [adapters/labbench/adapter.py](harbor/adapters/labbench/adapter.py:1) |
| lawbench | [adapters/lawbench/adapter.py](harbor/adapters/lawbench/adapter.py:1) |
| livecodebench | [adapters/livecodebench/adapter.py](harbor/adapters/livecodebench/adapter.py:1) |
| llmsr_bench | [adapters/llmsr_bench/adapter.py](harbor/adapters/llmsr_bench/adapter.py:1) |
| locomo | [adapters/locomo/src/locomo/adapter.py](harbor/adapters/locomo/src/locomo/adapter.py:1) |
| medagentbench | [adapters/medagentbench/adapter.py](harbor/adapters/medagentbench/adapter.py:1) |
| ml_dev_bench | [adapters/ml_dev_bench/src/ml_dev_bench_adapter/adapter.py](harbor/adapters/ml_dev_bench/src/ml_dev_bench_adapter/adapter.py:1) |
| mlgym-bench | [adapters/mlgym-bench/src/mlgym_bench/adapter.py](harbor/adapters/mlgym-bench/src/mlgym_bench/adapter.py:1) |
| mmau | [adapters/mmau/src/mmau/adapter.py](harbor/adapters/mmau/src/mmau/adapter.py:1) |
| mmmlu | [adapters/mmmlu/src/mmmlu/adapter.py](harbor/adapters/mmmlu/src/mmmlu/adapter.py:1) |
| multi-swe-bench | [adapters/multi-swe-bench/src/multi_swe_bench_adapter/adapter.py](harbor/adapters/multi-swe-bench/src/multi_swe_bench_adapter/adapter.py:1) |
| omnimath | [adapters/omnimath/src/omnimath/adapter.py](harbor/adapters/omnimath/src/omnimath/adapter.py:1) |
| osworld | [adapters/osworld/src/osworld/adapter.py](harbor/adapters/osworld/src/osworld/adapter.py:1) |
| pixiu | [adapters/pixiu/src/pixiu/adapter.py](harbor/adapters/pixiu/src/pixiu/adapter.py:1) |
| programbench | [adapters/programbench/src/programbench/adapter.py](harbor/adapters/programbench/src/programbench/adapter.py:1) |
| qcircuitbench | [adapters/qcircuitbench/src/qcircuitbench/adapter.py](harbor/adapters/qcircuitbench/src/qcircuitbench/adapter.py:1) |
| quixbugs | [adapters/quixbugs/src/quixbugs/adapter.py](harbor/adapters/quixbugs/src/quixbugs/adapter.py:1) |
| reasoning-gym | [adapters/reasoning-gym/src/reasoning_gym_adapter/adapter.py](harbor/adapters/reasoning-gym/src/reasoning_gym_adapter/adapter.py:1) |
| refav | [adapters/refav/src/refav_adapter/adapter.py](harbor/adapters/refav/src/refav_adapter/adapter.py:1) |
| replicationbench | [adapters/replicationbench/src/replicationbench/adapter.py](harbor/adapters/replicationbench/src/replicationbench/adapter.py:1) |
| research-code-bench | [adapters/research-code-bench/adapter.py](harbor/adapters/research-code-bench/adapter.py:1) |
| rexbench | [adapters/rexbench/src/rexbench/adapter.py](harbor/adapters/rexbench/src/rexbench/adapter.py:1) |
| satbench | [adapters/satbench/src/satbench/adapter.py](harbor/adapters/satbench/src/satbench/adapter.py:1) |
| scicode | [adapters/scicode/adapter.py](harbor/adapters/scicode/adapter.py:1) |
| scienceagentbench | [adapters/scienceagentbench/adapter.py](harbor/adapters/scienceagentbench/adapter.py:1) |
| seal0 | [adapters/seal0/src/seal0/adapter.py](harbor/adapters/seal0/src/seal0/adapter.py:1) |
| simpleqa | [adapters/simpleqa/src/simpleqa/adapter.py](harbor/adapters/simpleqa/src/simpleqa/adapter.py:1) |
| sldbench | [adapters/sldbench/src/sldbench/adapter.py](harbor/adapters/sldbench/src/sldbench/adapter.py:1) |
| spider2-dbt | [adapters/spider2-dbt/src/spider2_dbt/adapter.py](harbor/adapters/spider2-dbt/src/spider2_dbt/adapter.py:1) |
| spreadsheetbench-verified | [adapters/spreadsheetbench-verified/src/spreadsheetbench_verified/adapter.py](harbor/adapters/spreadsheetbench-verified/src/spreadsheetbench_verified/adapter.py:1) |
| strongreject | [adapters/strongreject/src/strongreject/adapter.py](harbor/adapters/strongreject/src/strongreject/adapter.py:1) |
| swebench | [adapters/swebench/src/swebench_adapter/adapter.py](harbor/adapters/swebench/src/swebench_adapter/adapter.py:1) |
| swebench_multilingual | [adapters/swebench_multilingual/src/swebench_multilingual/adapter.py](harbor/adapters/swebench_multilingual/src/swebench_multilingual/adapter.py:1) |
| swebenchpro | [adapters/swebenchpro/src/swebenchpro/adapter.py](harbor/adapters/swebenchpro/src/swebenchpro/adapter.py:1) |
| swegym | [adapters/swegym/adapter.py](harbor/adapters/swegym/adapter.py:1) |
| swelancer | [adapters/swelancer/src/swelancer/adapter.py](harbor/adapters/swelancer/src/swelancer/adapter.py:1) |
| swesmith | [adapters/swesmith/src/swesmith_adapter/adapter.py](harbor/adapters/swesmith/src/swesmith_adapter/adapter.py:1) |
| swtbench | [adapters/swtbench/src/swtbench/adapter.py](harbor/adapters/swtbench/src/swtbench/adapter.py:1) |
| tau3-bench | [adapters/tau3-bench/src/tau3_bench/adapter.py](harbor/adapters/tau3-bench/src/tau3_bench/adapter.py:1) |
| textarena | [adapters/textarena/src/textarena/adapter.py](harbor/adapters/textarena/src/textarena/adapter.py:1) |
| theagentcompany | [adapters/theagentcompany/adapter.py](harbor/adapters/theagentcompany/adapter.py:1) |
| usaco | [adapters/usaco/src/usaco/adapter.py](harbor/adapters/usaco/src/usaco/adapter.py:1) |
| webgen_bench | [adapters/webgen_bench/src/webgen_bench/adapter.py](harbor/adapters/webgen_bench/src/webgen_bench/adapter.py:1) |
| widesearch | [adapters/widesearch/adapter.py](harbor/adapters/widesearch/adapter.py:1) |

**附表 C．静态计数的复核方法与工作树快照**

本报告写于2026-11-05（Asia/Shanghai）。下列只读命令足以复核目录/registry计数；这些是源文件枚举，不是执行benchmark的结果。目录计数有明确口径，不能把定义数当可跑实例数：

```bash
python3 - <<'PY'
from pathlib import Path
import json
root = Path('/disk/disk_20T/wangxuehai')
r = json.loads((root/'harbor/registry.json').read_text())
print(len(r), len({x['name'] for x in r}), sum(len(x['tasks']) for x in r))
print(len([x for x in (root/'harbor/adapters').iterdir() if x.is_dir()]))
print(len(list((root/'terminal-bench-science/tasks').rglob('task.toml'))))
print(len(list((root/'ASI-Bench/tasks').rglob('task_meta.yaml'))))
print(len(list((root/'ResearchClawBench/tasks').rglob('task_info.json'))))
PY
```

Git SHA为读取工作树时的HEAD。有表示当时已有tracked未提交变更，报告引用实际工作树而非保证纯HEAD内容。快照由各仓库的.git/HEAD、所指ref和只读git status --porcelain -uno取得；未提交文件内容不由SHA覆盖。报告输出目录不属于这些源仓库。本次没有修改下表仓库。

| 仓库（本地路径） | HEAD | 已有tracked变更 |
|---|---|---|
| [orbit](orbit/.git/HEAD) | b52345c980d7d6b647308613c5f94dc539a04705 | 有 |
| [harbor](harbor/.git/HEAD) | f6cf2e2e86a102a9d2980ce8888f4bda251aa998 | 无 |
| [terminal-bench-science](terminal-bench-science/.git/HEAD) | 0efab0e6d7c6af5886e838990352ab85484cc234 | 无 |
| [ASI-Bench](ASI-Bench/.git/HEAD) | 54397d39202cb6b3d43b2b8621afdc95b0b9eb5b | 无 |
| [asta-bench](asta-bench/.git/HEAD) | afbddb757faf454e6ec39f2bd214b060d72bff75 | 有 |
| [ResearchClawBench](ResearchClawBench/.git/HEAD) | 2ee9264b51883c4320ee10be7433bd944b83e959 | 有 |
| [SandboxFusion](SandboxFusion/.git/HEAD) | 469de0845cb7d665bc68044d541aa3aa28c5b30a | 无 |
| [EvoScientist](EvoScientist/.git/HEAD) | 7568a6bc1f31d6497b19804a9e7b9bdffe87e75f | 有 |
| [open-science](open-science/.git/HEAD) | 1ddf3f14a18d567e9b6dad2dfc9ab21246da9a4f | 有 |
| [openscience](openscience/.git/HEAD) | e9844a49f1f4d93cbf5f88b8f4880c003adc6e61 | 无 |
| [autosci](autosci/.git/HEAD) | 7debda62b66d5fc905a93cbc7454f6f02de9df95 | 无 |
| [embodied-first-exam](embodied-first-exam/.git/HEAD) | 9dfae8611326c4f159ebe2211cb9b71a92139406 | 无 |
| [vla-evaluation-harness](vla-evaluation-harness/.git/HEAD) | cc260841a0a32be778ec8604504de4bd5e663a5f | 无 |

引用中的行号定位入口或关键逻辑；同一文件中相邻的分支/配置共同构成证据。设计文档和catalog只支持“已记录的设计/结果口径”，不能替代代码或本次实测。具体联网需求、硬件峰值、模型/judge重复性、外部registry最新内容、所有native parity仍按正文标记为未核实。


<!-- SOURCE_DEFINITIONS -->

[aiderconfig]: harbor/adapters/aider_polyglot/src/aider_polyglot/task-template/task.toml:15
[aidertest]: harbor/adapters/aider_polyglot/src/aider_polyglot/task-template/test.sh:1
[aimetest]: harbor/adapters/aime/src/aime/task-template/tests/test.sh:9
[algoconfig]: harbor/adapters/algotune/src/algotune/task-template/task.toml:39
[algograde]: harbor/adapters/algotune/src/algotune/task-template/tests/test_outputs.py:48
[arcconfig]: harbor/adapters/arc_agi_2/src/arc_agi_2/task-template/task.toml:21
[arcgrade]: harbor/adapters/arc_agi_2/src/arc_agi_2/task-template/tests/verify.py:17
[arxivtask]: asta-bench/astabench/evals/arxivdigestables/task.py:100
[asi]: orbit/packages/orbit/src/bench/asi.ts:253
[asijudgeexample]: ASI-Bench/tasks/chemistry/metadynamics_for_dipeptide_in_vacuum/task_eval.yaml:70
[asios]: ASI-Bench/ai4sci_bench/runner/os_sandbox.py:64
[asiroot]: ASI-Bench/tasks
[asisc]: ASI-Bench/tasks/biology/scrna_seq_analysis/task_eval.yaml:3
[asiscoring]: ASI-Bench/ai4sci_bench/core/scoring.py:106
[astaconfig]: asta-bench/astabench/config/v1.0.0.yml:4
[astacore]: asta-bench/astabench/evals/inspect_eval_wrappers/core_bench.py:1
[astads]: asta-bench/astabench/evals/inspect_eval_wrappers/ds1000.py:25
[astareg]: asta-bench/astabench/evals/_registry.py:1
[astasandbox]: asta-bench/astabench/util/sandbox/sandbox_compose.yaml:1
[astasuper]: asta-bench/astabench/evals/super/task.py:312
[atif]: harbor/src/harbor/models/trajectories/trajectory.py:12
[autoconfig]: harbor/adapters/autocodebench/src/autocodebench/task-template/task.toml:31
[autosci]: autosci/autosci/modes/scientist.py:33
[autotest]: harbor/adapters/autocodebench/src/autocodebench/task-template/tests/test.sh:1
[bfcladapter]: harbor/adapters/bfcl/src/bfcl_adapter/adapter.py:475
[bfclconfig]: harbor/adapters/bfcl/src/bfcl_adapter/task-template/task.toml:22
[bfclinstr]: harbor/adapters/bfcl/src/bfcl_adapter/task-template/instruction.md:1
[bigconfig]: harbor/adapters/bigcodebench_hard/src/bigcodebench_hard/task-template/task.toml:46
[bigtest]: harbor/adapters/bigcodebench_hard/src/bigcodebench_hard/task-template/tests/test.sh:1
[birdconfig]: harbor/adapters/bird_bench/src/bird_bench/task-template/task.toml:26
[birdgrade]: harbor/adapters/bird_bench/src/bird_bench/task-template/tests/evaluate.py:18
[bixconfig]: harbor/adapters/bixbench/src/bixbench/task-template/task.toml:22
[bixtest]: harbor/adapters/bixbench/src/bixbench/task-template/tests/test.sh:1
[calibrate]: orbit/packages/orbit/src/cli/calibrate.ts:57
[catalog]: orbit/docs/catalog.md:3
[compileadapter]: harbor/adapters/compilebench/src/compilebench/adapter.py:25
[coopadapter]: harbor/adapters/cooperbench/src/cooperbench/adapter.py:297
[coopconfig]: harbor/adapters/cooperbench/src/cooperbench/task-template/task.toml:28
[cooptest]: harbor/adapters/cooperbench/src/cooperbench/task-template/tests/test.sh:65
[crustconfig]: harbor/adapters/crustbench/template/task.toml:31
[crusttest]: harbor/adapters/crustbench/template/tests/test.sh:79
[dab]: harbor/adapters/dabstep/adapter.py:66
[dabconfig]: harbor/adapters/dabstep/template/task.toml:13
[dabscore]: harbor/adapters/dabstep/scorer.py:43
[dbtconfig]: harbor/adapters/spider2-dbt/src/spider2_dbt/task-template/task.toml:29
[dbttest]: harbor/adapters/spider2-dbt/src/spider2_dbt/task-template/tests/test.sh:18
[discovery]: asta-bench/astabench/evals/discoverybench/task.py:104
[dstest]: harbor/adapters/ds1000/template/test.sh:1
[e2e]: asta-bench/astabench/evals/e2e_discovery/task.py:370
[efe]: embodied-first-exam/tasks/metaworldplus/metaworldplus-button-press-i00-standard/instruction.md:6
[evoscientist]: EvoScientist/EvoScientist/EvoScientist.py:781
[evotest]: harbor/adapters/evoeval/templates/tests/test.sh:1
[featureconfig]: harbor/adapters/featurebench/template/task.toml:8
[featuretest]: harbor/adapters/featurebench/template/tests/test.sh:1
[financeconfig]: harbor/adapters/financeagent/template/task.toml:28
[financegrade]: harbor/adapters/financeagent/template/tests/run_test.py:11
[gaiaconfig]: harbor/adapters/gaia/template/task.toml:11
[gaiagrade]: harbor/adapters/gaia/template/tests/test.sh:17
[gpqaconfig]: harbor/adapters/gpqa-diamond/template/task.toml:13
[gpqagrade]: harbor/adapters/gpqa-diamond/template/tests/test.sh:8
[gsoconfig]: harbor/adapters/gso/template/task.toml:13
[gsotest]: harbor/adapters/gso/template/tests/test.sh:33
[harbor]: orbit/packages/orbit/src/bench/harbor.ts:238
[hcfg]: harbor/src/harbor/models/task/config.py:435
[hefixconfig]: harbor/adapters/humanevalfix/template/task.toml:12
[hefixtest]: harbor/adapters/humanevalfix/template/tests/test.sh:12
[hlcb]: harbor/adapters/livecodebench/adapter.py:194
[hlcbconfig]: harbor/adapters/livecodebench/template/task.toml:11
[hlcbdocker]: harbor/adapters/livecodebench/template/Dockerfile:7
[hlcbfinal]: harbor/adapters/livecodebench/template/final_test.py:411
[hreward]: orbit/packages/orbit/src/bench/harbor.ts:667
[hverifier]: harbor/src/harbor/verifier/verifier.py:69
[ineqconfig]: harbor/adapters/ineqmath/template/task.toml:13
[ineqtest]: harbor/adapters/ineqmath/template/tests/test_outputs.py:1
[kumocli]: harbor/adapters/kumo/template/environment/kumo_cli.py:14
[kumoconfig]: harbor/adapters/kumo/template/task.toml:11
[kumograde]: harbor/adapters/kumo/template/tests/score.py:20
[kumoinstr]: harbor/adapters/kumo/template/instruction.md:1
[lancerconfig]: harbor/adapters/swelancer/src/swelancer/task-template/task.toml:18
[lawconfig]: harbor/adapters/lawbench/template/task.toml:11
[lawgrade]: harbor/adapters/lawbench/template/tests/test.py:43
[ldruntime]: orbit/examples/bench-adapters/longds/runtime.py:50
[lds]: orbit/examples/bench-adapters/longds/adapter.py:78
[litqa]: asta-bench/astabench/evals/labbench/litqa2/task.py:114
[medconfig]: harbor/adapters/medagentbench/template/task.toml:10
[medtest]: harbor/adapters/medagentbench/template/tests/test.sh:24
[mldevconfig]: harbor/adapters/ml_dev_bench/src/ml_dev_bench_adapter/task-template/task.toml:17
[mldevtest]: harbor/adapters/ml_dev_bench/src/ml_dev_bench_adapter/task-template/tests/test.sh:20
[mlenote]: ASI-Bench/1018_explore/literature/science_agents.md:21
[mlgymadapter]: harbor/adapters/mlgym-bench/src/mlgym_bench/adapter.py:624
[mlgymconfig]: harbor/adapters/mlgym-bench/src/mlgym_bench/task-template/task.toml:30
[mlgymtest]: harbor/adapters/mlgym-bench/src/mlgym_bench/task-template/tests/test.sh:10
[mmauconfig]: harbor/adapters/mmau/src/mmau/task-template/task.toml:3
[mmaugrade]: harbor/adapters/mmau/src/mmau/task-template/tests/test_outputs.py:15
[mmmluconfig]: harbor/adapters/mmmlu/src/mmmlu/task-template/task.toml:23
[mmmlutest]: harbor/adapters/mmmlu/src/mmmlu/task-template/tests/test.sh:1
[multisweconfig]: harbor/adapters/multi-swe-bench/src/multi_swe_bench_adapter/task-template/task.toml:32
[multiswetest]: harbor/adapters/multi-swe-bench/src/multi_swe_bench_adapter/task-template/tests/test.sh:1
[oclassify]: orbit/packages/orbit/src/bench/classify.ts:29
[ocontract]: orbit/packages/orbit/src/contracts/bench.ts:333
[ointegration]: orbit/docs/design.md:979
[ointeraction]: orbit/docs/design.md:839
[olifecycle]: orbit/docs/design.md:843
[ometrics]: orbit/packages/orbit/src/contracts/metrics.ts:40
[opensciagent]: openscience/backend/cli/src/agent/agent.ts:79
[openscipkg]: openscience/backend/cli/package.json:1
[oprotocol]: orbit/docs/design.md:550
[ospkg]: open-science/package.json:1
[ossdk]: open-science/packages/sdk/src/OpenCodeClient.ts:1
[otrajectory]: orbit/packages/orbit/src/contracts/trajectory.ts:1
[otrajectorydesign]: orbit/docs/design.md:916
[paperfinder]: asta-bench/astabench/evals/paper_finder/task.py:38
[papernote]: openscience/backend/cli/skills/ml-training/unsloth/docs/kimi-k2.5.md:604
[pdeconfig]: harbor/adapters/codepde/src/codepde/task-template/task.toml:20
[pdetest]: harbor/adapters/codepde/src/codepde/task-template/tests/test.sh:12
[pixconfig]: harbor/adapters/pixiu/src/pixiu/task-template/task.toml:24
[pixgrade]: harbor/adapters/pixiu/src/pixiu/task-template/tests/test_pixiu.py:23
[ptb]: orbit/examples/bench-adapters/posttrainbench/adapter.py:283
[qcconfig]: harbor/adapters/qcircuitbench/src/qcircuitbench/task-template/task.toml:19
[qctest]: harbor/adapters/qcircuitbench/src/qcircuitbench/task-template/tests/test.sh:80
[quixconfig]: harbor/adapters/quixbugs/src/quixbugs/task-template/task.toml:19
[rcb]: orbit/examples/bench-adapters/researchclawbench/adapter.py:114
[rcbscore]: ResearchClawBench/evaluation/score.py:681
[regfactory]: harbor/src/harbor/registry/client/factory.py:10
[registry]: harbor/registry.json:1
[repconfig]: harbor/adapters/replicationbench/src/replicationbench/task-template/task.toml:30
[repgrade]: harbor/adapters/replicationbench/src/replicationbench/task-template/tests/test_outputs.py:12
[reptest]: harbor/adapters/replicationbench/src/replicationbench/task-template/tests/test.sh:6
[researchcode]: harbor/adapters/research-code-bench/template/tests/test.sh:34
[researchcodeconfig]: harbor/adapters/research-code-bench/template/task.toml:11
[rexconfig]: harbor/adapters/rexbench/src/rexbench/task-template/task.toml:19
[rextest]: harbor/adapters/rexbench/src/rexbench/task-template/tests/test.sh:20
[rgconfig]: harbor/adapters/reasoning-gym/src/reasoning_gym_adapter/task-template/task.toml:25
[rggrade]: harbor/adapters/reasoning-gym/src/reasoning_gym_adapter/task-template/tests/test_output.py:20
[satconfig]: harbor/adapters/satbench/src/satbench/task-template/task.toml:23
[satgrade]: harbor/adapters/satbench/src/satbench/task-template/tests/verify.py:14
[sfapi]: SandboxFusion/sandbox/datasets/types.py:35
[sfhe]: SandboxFusion/sandbox/datasets/humaneval.py:182
[sflcb]: SandboxFusion/sandbox/datasets/live_code_bench.py:1013
[sflocal]: SandboxFusion/sandbox/configs/local.yaml:1
[sfmbpp]: SandboxFusion/sandbox/datasets/mbpp.py:64
[sfregistry]: SandboxFusion/sandbox/registry.py:9
[sfrun]: SandboxFusion/sandbox/server/sandbox_api.py:40
[sheetconfig]: harbor/adapters/spreadsheetbench-verified/src/spreadsheetbench_verified/task-template/task.toml:22
[sheettest]: harbor/adapters/spreadsheetbench-verified/src/spreadsheetbench_verified/task-template/tests/test.sh:1
[simpleconfig]: harbor/adapters/simpleqa/src/simpleqa/task-template/task.toml:12
[simplejudge]: harbor/adapters/simpleqa/src/simpleqa/task-template/tests/llm_judge.py:104
[simpletest]: harbor/adapters/simpleqa/src/simpleqa/task-template/tests/test.sh:1
[sldconfig]: harbor/adapters/sldbench/src/sldbench/task-template/task.toml:25
[sldtest]: harbor/adapters/sldbench/src/sldbench/task-template/tests/test.sh:1
[smithconfig]: harbor/adapters/swesmith/src/swesmith_adapter/task-template/task.toml:27
[smithtest]: harbor/adapters/swesmith/src/swesmith_adapter/task-template/tests/test.sh:1
[sqatask]: asta-bench/astabench/evals/sqa/task.py:405
[strongconfig]: harbor/adapters/strongreject/src/strongreject/task-template/task.toml:23
[strongfinal]: harbor/adapters/strongreject/src/strongreject/task-template/tests/test_outputs.py:319
[stronggrade]: harbor/adapters/strongreject/src/strongreject/task-template/tests/test_outputs.py:119
[sweadapter]: harbor/adapters/swebench/src/swebench_adapter/adapter.py:42
[sweconfig]: harbor/adapters/swebench/src/swebench_adapter/task-template/task.toml:18
[swegrade]: harbor/adapters/swebench/src/swebench_adapter/task-template/tests/test.sh:17
[sweic]: harbor/adapters/swelancer/src/swelancer/task-template/swe/tests/test.sh:22
[swemanager]: harbor/adapters/swelancer/src/swelancer/task-template/manager/tests/test.sh:4
[swemulticonfig]: harbor/adapters/swebench_multilingual/src/swebench_multilingual/task-template/task.toml:19
[swemultitest]: harbor/adapters/swebench_multilingual/src/swebench_multilingual/task-template/tests/test.sh:1
[sweproconfig]: harbor/adapters/swebenchpro/src/swebenchpro/task-template/task.toml:12
[sweprotest]: harbor/adapters/swebenchpro/src/swebenchpro/task-template/test.sh:95
[swtconfig]: harbor/adapters/swtbench/src/swtbench/task-template/task.toml:18
[swttest]: harbor/adapters/swtbench/src/swtbench/task-template/tests/test.sh:20
[tauconfig]: harbor/adapters/tau3-bench/src/tau3_bench/task-template/task.toml:18
[taueval]: harbor/adapters/tau3-bench/src/tau3_bench/task-template/tests/evaluate.py:116
[tbconfig]: terminal-bench-science/tasks/earth-sciences/atmospheric-sciences/sparse-network-assimilation/task.toml:31
[tbconfig2]: terminal-bench-science/tasks/earth-sciences/environmental-sciences/hysteretic-aquifer-control/task.toml:35
[tbgrade]: terminal-bench-science/tasks/earth-sciences/atmospheric-sciences/sparse-network-assimilation/tests/grader.py:100
[tbroot]: terminal-bench-science/tasks
[tbtest]: terminal-bench-science/tasks/earth-sciences/atmospheric-sciences/sparse-network-assimilation/tests/test.sh:4
[textconfig]: harbor/adapters/textarena/src/textarena/task-template/task.toml:21
[textserver]: harbor/adapters/textarena/src/textarena/task-template/environment/game_server.py:21
[texttest]: harbor/adapters/textarena/src/textarena/task-template/tests/test.sh:17
[usacoconfig]: harbor/adapters/usaco/src/usaco/task-template/task.toml:18
[usacotest]: harbor/adapters/usaco/src/usaco/task-template/tests/test.sh:1
[vlalibero]: vla-evaluation-harness/src/vla_eval/benchmarks/libero/benchmark.py:225
[vlaproto]: vla-evaluation-harness/src/vla_eval/protocol/messages.py:15
