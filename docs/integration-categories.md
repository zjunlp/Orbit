# Benchmark 大类与接入规范

状态：**已确认并开始实施**（2026-11-05；EFE 归 C2 + 具身 profile，原生具身归 C6）。实施进度见 §7。依据为四份调研报告：[外部生态](research/taxonomy/landscape.md)、
[具身](research/taxonomy/embodied.md)、[GUI](research/taxonomy/gui.md)、[代码/科研/问答](research/taxonomy/code.md)。
这些报告由 Codex 读取本机各 bench 源码并联网查阅官方资料后写成，事实带出处；本文是在此基础上的取舍。

## 0. 一句话

**按"被评测对象怎样与任务交互"分 7 个大类；环境、评分方式、是否联网作为大类下的 profile。** 每个具体 benchmark
用自己的身份（原始任务来源 + 版本）直接登记到它的大类下；Harbor、BrowserGym、vla-eval 这类 hub 或库只是实现手段，
不再是 benchmark 身份的上一层。只有当某个 hub **重新定义了考题**（例如 EFE 把机器人任务改成 coding agent 的考题）时，
它本身才是一个 benchmark。

## 1. 为什么这样分

四份调研的共同结论：领域标签（"机器人""网页""科研"）预测不了接入差异。真正决定 Orbit 要做什么不同事情的，按影响
从大到小是：

1. **被评测对象及其边界**：一个模型请求、一个在工作区里自主工作的 Agent、一个每步输出动作的 policy，启动方式、
   谁持有状态、交付什么完全不同。
2. **交互契约**：单次输入输出 / 工具循环 / 与模拟用户对话 / GUI 观测-动作 / 物理闭环控制 / 多方对局。它决定
   一个 trial 是一次请求、一次求解、一个 episode 还是一局比赛，以及停止、复位、同步的规则。
3. **环境与可复位性**（profile）：无环境、工作区容器、自托管网站、真实网页、桌面 VM、手机模拟器、仿真器、真机。
4. **评分来源**（profile）：答案匹配、测试、状态检查、环境 reward、LLM judge、人工/成对比较。
5. **领域、模态**：只作检索标签和分组统计。

反例说明为什么不能按领域分：同一个 LIBERO，原生版本测的是 VLA policy（每步给动作），EFE 版本测的是 coding agent
（写控制程序或调用仿真 API）；同一个 BFCL，静态题是一次输出，执行版是工具循环；同一个浏览器，WebArena 是冻结网站，
Online-Mind2Web 是真实网页加 judge。

## 2. 七个大类

| 大类 | 纳入规则（这一轮评测的到底是什么） | 典型 benchmark | profile |
| --- | --- | --- | --- |
| **C1 固定输入响应** | 给模型固定输入（含固定多轮历史），取输出或概率；没有根据输出演化的外部环境 | GPQA、SimpleQA、HumanEval/MBPP/LiveCodeBench（一次生成后执行测试）、静态 BFCL、GUI grounding、离线下一动作预测 | `generate` / `likelihood`；评分 `match` / `exec-test` / `judge`；模态 text / image / audio |
| **C2 Agent 工作区** | Agent 在可读写的工作区里自主运行命令、改代码、训练、调试，交付 patch / 文件 / 模型 / 报告 / 控制程序；交付物及其执行是评测对象 | SWE-bench、Terminal-Bench、TB-Science、MLE-bench、PaperBench、RE-Bench、ASI、ResearchClawBench、LongDS、PostTrainBench、**EFE** | `repo-patch` / `terminal` / `ml-experiment` / `research-report` / `embodied-program`（交付后回放判分）/ `embodied-live`（在线操纵仿真，sidecar 实时判分） |
| **C3 工具/API 工作流** | Agent 自主选择语义工具（函数、MCP、搜索），消费结果、改变或查询应用状态，最终回答或完成目标；没有模拟用户 | GAIA（工具版）、MCPMark、MCP-Universe、MCP-Bench、BFCL 执行循环 | `local-state` / `remote-service` / `search`；世界 `frozen` / `live` |
| **C4 模拟用户会话** | Agent 与独立的用户角色持续对话；用户掌握信息或也能操作环境，成功依赖协同 | τ-bench、τ²-bench（含 dual-control、语音） | `text` / `voice`；`single-control` / `dual-control` |
| **C5 GUI 交互** | 通过截图 / DOM / 无障碍树观测，以 GUI 动作操作应用完成任务；被测对象是 VLM agent、外部 policy，或经 `orbit-computer` 桥接的 CLI Agent | MiniWoB++、WebArena、VisualWebArena、WebVoyager、Online-Mind2Web、OSWorld、Windows Agent Arena、AndroidWorld、MobileWorld、Cua Bench | 平台 `browser` / `desktop` / `mobile`；世界 `fixture` / `mirrored` / `live`；观测-动作 `coordinate` / `element-tree` / `native-code` |
| **C6 具身策略闭环** | 固定的 policy / planner 在仿真或真机中按观测输出有物理含义的动作（或 action chunk、子目标）；复位、时序、控制映射属于协议 | 原生 LIBERO、RoboCasa、MetaWorld、RoboTwin、ManiSkill、SimplerEnv、CALVIN、BEHAVIOR、VLABench、Isaac Lab Arena、RoboArena | `sim` / `real`；`sync` / `realtime`；`step` / `chunk` / `goal`；单 episode / 长程子目标 |
| **C7 游戏与多主体** | 规则定义的对局；包含玩家、回合、对手或队友、按玩家返回的效用（允许单人） | TextArena、BALROG、AgentBench 卡牌游戏 | `turn-based` / `simultaneous`；`competitive` / `cooperative` |

**归类裁决顺序**（任务同时像几类时，先固定被测对象和原始协议，再取最强约束）：物理动作 / 实时控制 → C6；强制 GUI 观测-动作
→ C5；在工作区求解并交付程序或产物 → C2；与模拟用户协同 → C4；对局规则 → C7；一般工具循环 → C3；其余 → C1。
一个 benchmark 提供两种实质不同的交互方式时，登记为两个 variant（例如 BFCL 静态 / 执行），不强行二选一。

**容易误分的三点**：

- EFE 的 standard 模式虽然内部有物理控制，被测对象是现场写代码、调用仿真 API 的 coding agent，因此是
  **C2 + `embodied-live`**，不是 C6；privileged 模式交付轨迹或程序后回放判分，是 **C2 + `embodied-program`**。
  roboEngineer 虽名为 standard，交付的是控制器，按交付物归 `embodied-program`。EFE 的 BEHAVIOR 与原生 BEHAVIOR
  动作空间、成功条件都不同，是两个 benchmark，排行榜不能合并。
- "用了 LLM judge" 不构成一个大类：PaperBench（C2）、Online-Mind2Web（C5）、SimpleQA（C1）都用 judge。judge 是评分 profile。
- "用了 MCP" 也不构成一个大类：MCP 只是传输。CLI Agent 经 MCP 点击网页仍是 C5。

## 3. 每类的规范：五个真正不同的接入点

所有大类共用同一套底座：daemon 独占状态、资源租约、Run 与阶段执行器、证据采集与签名、封闭的失败类型、
有效均值与官方口径并列、报告修订、Web 结果索引。类别**不**另建队列、账本或执行路径，只规定以下五点。

| 接入点 | C1 固定输入 | C2 工作区 | C3 工具 | C4 模拟用户 | C5 GUI | C6 具身策略 | C7 对局 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **① 被测端输入/输出** | 固定样本 → 原始响应 + 解析结果；固定 prompt 模板、解析、归一化 | 任务 + 工作区快照 + 允许工具和预算 → 声明的交付清单（路径、hash、入口） | 工具 schema、版本 → 工具调用序列 + 最终答复 | agent 与 user 各自的可见指令、隐藏目标、工具；消息角色与结束信号 | 声明的观测组合、视口与坐标系、动作集合 → 动作序列 + 可选答案 | 相机顺序/分辨率、本体状态、语言、动作维度/单位/频率/chunk → 动作；policy 权重与预处理属于方法身份 | 玩家、角色、各自可见观测、合法动作、轮转规则 → 动作；按玩家的效用 |
| **② 生命周期与资源** | 批量请求；模型端点、并发、API 配额；通常无每题环境 | prepare → solve → 封存交付 → (复现) → verify → 采集；agent、训练、仿真、grader 按角色租资源 | 每 trial 隔离命名空间与 fixture；服务就绪检查；结束复位 | 共享业务状态 + 被测 agent + 用户模拟器；两边分别计费限额 | browser / VM / 模拟器各自就绪与复位；实例归属 dedicated / pooled / singleton / remote，复位确认后才释放 | 仿真与 policy 服务原子同租；按 episode 计划固定初态与 seed；realtime 声明时钟、丢帧、迟到动作 | 固定对手名单与 seed；回合超时、同时行动屏障、掉线弃权规则 |
| **③ 评分与有效性** | 匹配 / 执行测试 / judge；格式错误是有效失败，请求从未成功、输入损坏、scorer 不可用为无效 | 可信测试、隐藏数据、sidecar 或独立复现；agent 可写区域与评分隔离；缺交付可为有效 0，环境或 grader 故障为无效 | 按最终状态与约束评分；工具调用成功 ≠ 任务成功；agent 参数错误是行为，服务 5xx / fixture 故障为无效 | 检查事务状态与沟通要求；用户模拟器失效与 agent 决策错误分开 | 优先原版状态检查；judge 是另一来源并单独记录版本；走错页是失败，快照无法恢复是环境故障 | 原版成功判定（ever / final / hold 要声明）；到达 horizon 是正常失败；复位失败、传感器损坏为无效 | 胜负平、回报；违规与超时按规则判负；服务故障另记；不能从分母删掉被测方的错误 |
| **④ 证据与轨迹** | 输入 hash、实际请求、完整响应、解析、参考答案引用、scorer 输出 | Agent 会话、diff、交付物 hash、测试日志、rubric 叶节点；EFE 加仿真动作与视频（注明 live / 回放） | 工具发现结果、调用 id、参数、返回、副作用、前后状态差 | 双方消息与工具、共享状态、结束原因；语音保留音频与时间对齐 | 截图与动作一一对应、动作前后观测、URL/窗口、reward；可信 service 签名 | 高频观测/动作/时间/reward、多相机视频、状态快照、policy 延迟；原生数组保留，Web 用 episode 时间线 | 事件顺序、玩家 id、可见性、动作合法性、每玩家 reward；回放可全知但不得泄漏给 agent |
| **⑤ 校准** | 已知正确/错误答案、解析边界；不要求 empty 全为 0 | 参考解、故意坏的交付、缺交付；研究类验证真复现；再用一个真实方法与原 runner 对齐 | 已知正确调用序列、缺工具、schema 错误、外部失败 | 固定用户模型与提示；协同成功、合理拒绝、异常退出；多次重复报告 `pass^k` | 脚本化成功/失败路径、坐标映射、复位、终态 evaluator；live 世界测可达性与 judge 一致性 | 已知 checkpoint 或专家演示回放、动作单位与方向、复位确定性；**静止 policy 不保证得 0** | 规则边界、非法动作、角色互换、固定脚本对手 |

**每个直接登记的 benchmark 必须给出的最小声明**（与实现方式 L0/L1/L2 无关）：

```text
identity     原始任务来源 + 版本 + 任务/实例 digest；包装改变了考题时，包装本身是 identity
category     C1..C7 + 必需 profiles；被测对象与 scaffold 的边界
io           输入输出 schema、可见信息、工具与动作权限、结束信号
environment  组件及归属、就绪 / 复位 / 停止 / 清理、隔离范围
resources    按角色的 CPU / 内存 / GPU（型号、显存）/ 磁盘 / 设备 / API 配额 / 时钟预算
scoring      原版 scorer + 版本 + 输入证据 + 指标单位与方向 + 官方聚合与缺项规则
validity     原版错误 → 封闭失败类型；任务失败与设施故障的边界
trajectory   原生格式 + 统一索引映射 + 完整度 + 产生者与信任级
calibration  按类别的正例 / 负例 / 边界期望、原生对照、偏差清单
```

## 4. 现有接入按新规范的归类

| 现有接入 | 大类 + profile | 与新规范的差距 |
| --- | --- | --- |
| EFE（2,260 个模式目录） | C2 + `embodied-program`（privileged，1,034）/ `embodied-live`（standard 1,142、realtime 84） | profile 需从 task 元数据自动生成；校准期望按 oracle 覆盖（full 1,313 / partial 141 / none 806）分别给 |
| vla-eval LIBERO（适配器与清单） | C6 + `sim` / `step` | **trial.seed 没有传到环境**，每次都从 episode 0 开始；一个 trial 合并多个 episode 会丢失逐 episode 有效性；verify 只是重读 aggregate。需改为显式 episode 计划 |
| BrowserGym / MiniWoB、CUA-Lite、Cua Bench | C5 + `browser`（Cua 为 `desktop`）+ `fixture` | 已基本符合；CUA-Lite 的 WebVoyager / Online-Mind2Web 是 `live` + judge，要单独计分 |
| OSWorld-V2、MobileWorld | C5 + `desktop` / `mobile` | 需要 KVM 真实校准；MobileWorld 的用户模型、MCP 辅助模式要作为独立 variant |
| TB-Science、TB 4.0、ASI、PostTrainBench | C2 + `terminal` / `ml-experiment` | 指标单位与方向要声明（例如加速比不能显示成百分比） |
| ResearchClawBench、LongDS | C2 + `research-report`（LongDS 每轮答案按 judge） | judge 未评项必须为无效，不能补 0 |
| 尚未覆盖 | C1、C3、C4、C7 整类；C6 的原生 benchmark 只有 LIBERO 一个 | — |

## 5. 对 Orbit 的改动（确认后实施）

1. **契约**：`BenchCapabilities` 增加 `category`（C1–C7）与 `profiles`（受控取值），取代现在只有
   `browser / desktop / mobile / other` 的 `kind`（旧记录映射到 C5 或 unknown）。Web 与 catalog 按大类组织。
2. **身份**：benchmark 登记带原始来源与版本；catalog 以 benchmark 为行、大类为组，hub / 库写在"实现"一列。
3. **按类别的校准**：`orbit bench calibrate` 的期望改为由类别和 benchmark 声明（允许 empty ≠ 0、没有 oracle、
   有容差的连续指标、judge 的重复一致性统计），替代现在统一的"empty = 0、oracle 满分、严格相等"。
   调研已找到反例：StrongReject 空回答正常得 1；部分具身任务静止即满足目标。
4. **按类别的有效性映射**：每类给出原版错误到封闭失败类型的映射表；补上调研发现的吞错路径
   （TextArena 服务失败写 0、SimpleQA 解析失败默认选 C、TB-Science 脚本非零退出折成 0）。
5. **按类别的 SDK 钩子**：现有 L1 清单 / L2 SDK 增加类别模板，例如 C6 模板提供 episode 计划、policy 服务握手、
   逐 episode 结果；C5 模板即现有 `orbit-gui-service`。
6. **样板**：每类先做一个直接接入的样板，并完整走规范与校准：
   C6 原生 LIBERO（修正 seed 与逐 episode）、C2 EFE（profile 自动生成）、C5 MiniWoB（已有，补声明）、
   C1 一个问答或代码生成集、C3 一个 MCP 类、C4 τ²-bench、C7 TextArena 的一个单人游戏。

## 6. 已确认的决策（2026-11-05）

1. 采用 7 个大类。
2. EFE 归 C2（coding agent）+ `embodied-program` / `embodied-live`，另带 `domains: [embodied]` 标签，Web 可按领域
   把 EFE 与原生具身 benchmark 放在同一视图，但排行榜分开；原生具身 benchmark 归 C6。
3. 先做 C6 原生 LIBERO 与 C2 EFE 的规范化，再给其余各类各做一个样板。

## 7. 实施进度

| 项 | 状态 | 位置 |
| --- | --- | --- |
| 契约：`category`、`profiles`（按类受控取值）、`domains`、`calibration` 期望；旧 `kind` 映射 | 已实现 | `contracts/categories.ts`（无依赖，Web 运行时可用）、`contracts/bench.ts` |
| 按类别的校准期望（empty / oracle / 重复容差 / seed 取不同初态），benchmark 可覆盖；oracle 不全的任务不判 oracle、抽样优先 full | 已实现 | `cli/calibrate.ts` |
| C2 EFE：每个任务按模式自动给出 profile（program 1,064 / live 1,196）、oracle 覆盖、交付类型 | 已实现 | `bench/harbor.ts` `embodiedTags` |
| C6 LIBERO：一个 trial 一个 episode，seed n 取初态 n-1（越界拒绝），结果核对计划的初态与任务；适配器与清单两种实现 | 已实现，真机三个 seed 三个不同初态 | `examples/bench-adapters/vla-eval`、`examples/bench-manifests/vla-eval-libero` |
| 现有适配器声明类别（GUI 5 个、科研/训练 3 个、vla-eval、Harbor 内置） | 已实现 | `examples/bench-adapters/*` |
| Web：作业列表按类别筛选与标注，新建作业显示类别 | 已实现 | `packages/web/src/lib/category.ts` |
| 有效性：上游 verifier 在自身故障时写 0 的情形——已知故障信息（TextArena 游戏服务不可达 / 无 reward）判 invalid（`infra`）；评分脚本抛出非断言异常后得 0 时加 issue 提示复核（TB-Science 等 `|| echo 0` 写法） | 已实现（Harbor 路径） | `bench/harbor.ts` `harborReward` |
| SimpleQA judge 解析失败默认 C（未作答）、其余 judge 吞错 | 未开始（需随 C1 样板接入时处理） | — |
| C1 / C3 / C4 / C7 样板 | 未开始 | — |
| EFE standard GPU 任务（pandadyn）真实运行 | Orbit 侧通过：sim 租 1 卡、rcb_monitor 经 `gpusOf` 看同卡、Agent 容器无 GPU；sim 失败被判 invalid（infra）而非 0；取消后无残留与租约。任务本身失败：本机容器内 Vulkan `vkCreateDevice` 初始化失败（CDI 与 `--gpus` 相同，与 Orbit 无关），需排查主机图形驱动 | — |
