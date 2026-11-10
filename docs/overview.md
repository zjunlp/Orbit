# Orbit 项目总览（2026-11-05 历史快照）

本文保留当时的实现、验证与缺口，供追溯决策，不作为当前产品目录或待办清单。文中的 C1–C7 是历史接入原型，
不再作为产品分类；当前公开分类为六个独立维度及各自的受控取值，见 [design §9.17](design.md#917-benchmark-六维分类-v12026-11-09)。
当前架构、状态与已适配产品分别以 [design.md](design.md)、[status.md](status.md)、[catalog.md](catalog.md) 为准；
旧编号的兼容范围见 [历史接入规范](integration-categories.md)。

## 1. 到什么程度了

Orbit 让 Codex / Claude Code 等 Agent 在隔离的 Docker 容器里按资源规则跑实验，完整记录过程与结果，用 Web 复盘。
有两种用法，共用同一个执行原语 Run：**日常科研**（宿主机 Agent 改代码 → `orbit run` 放进容器跑）和
**刷榜**（`方法 × Benchmark`，每个 trial 先 solve 再独立 verify）。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| R0–R2 | TS 重写、单机科研闭环、认证与通知 | 完成，本机真实验证 |
| R3 | 刷榜（ASI、TB-Science、LongDS） | 完成；分数只做到 oracle 级核对，未与官方 Harbor 跑分逐项对比 |
| R4 | 多节点 | 已实现；只在同一台机器上用两个 daemon 模拟验证，没有两台真机 |
| P1–P7 | Agent 注册表、评测身份、GUI/具身接入、CLI Agent 桥、接入层（L0/L1/L2）、规模与可靠性 | 完成（P7 中暖池、实例账本、slots、导出后置） |
| 7 大类样板 | C1–C7 各一个直接接入的样板，全部校准通过 | 完成（只用 empty / oracle / 脚本方法，未调用模型） |
| P8 真机 | 设备提供者 | 未开始，需要合作方和设备 |

规模：`packages/orbit/src` 约 2.4 万行 TS，Web 约 1.3 万行；Orbit 590 个测试、Web 62 个；npm 包 `@zjunlp/orbit` 已发布。

**一句话判断**：平台底座（执行、资源、记录、有效性、校准）已经比较完整；**真正缺的是"用真实模型跑出可信分数"**——
几乎所有接入只证明了"能跑、判分正确"（empty 得 0、oracle 满分），还没有用真实 Agent / 模型跑出与官方结果对得上的分数。

## 2. 架构

```
宿主机 Agent (Codex / Claude Code / …)  ── plugin(skill) / CLI --json / Web
                         │ HTTP (127.0.0.1, token)
                         ▼
orbit daemon（每台机器一个，本机状态的唯一写者，sqlite）
  resources  GPU/CPU/内存/设备账本、租约、排队、对账回收、主机保护
  runs       Run 状态机、调度、阶段与 hooks、sidecar 服务、清理、checkpoint/resume
  executor   Docker（CDI GPU 映射并核对租约）；process 后端
  harness    Agent 注册表（安装、凭据、argv、会话解析）；auth / notify / feishu
  bench      adapter → trial（solve + verify）→ 有效性 → 聚合 / 报告修订 / 重评
  cluster    多节点：加入、放置、代码包、日志镜像
                         ▼
Web（daemon 自带的 React SPA）：Runs、Run 详情、对比、资源、Bench 作业/矩阵/trial、GUI 与具身时间线
```

几个关键概念：

- **Run**：一次容器执行，带代码快照、资源租约、日志/指标/产物。科研和刷榜都用它，只有一个状态机、一个账本。
- **Bench 作业**：`方法 × 任务 × seed` 的矩阵；每个 trial = solve Run + verify Run。**执行结果、清理状态、评测有效性是三个独立字段**；
  只有 valid 的 trial 进入均值，失败归入封闭的 `failure` 类型（infra、scorer_error、model_error…），与官方口径并列显示。
- **接入层级**：L0 Harbor 格式（零代码，`orbit bench add`）；L1 `orbit-bench.yaml` 清单；L2 Python SDK（`orbit_bench`）。
  三者都编译成同一个 adapter 协议，不另建执行路径。
- **7 个大类**（按"被评测对象怎样与任务交互"分）：C1 固定输入、C2 Agent 工作区、C3 工具工作流、C4 模拟用户、
  C5 GUI、C6 具身策略、C7 游戏。类别决定校准期望（例如具身静止策略不保证得 0、游戏没有 oracle 时不判满分）。
- **验收工具**：`orbit bench coverage`（能跑多少任务）与 `orbit bench calibrate`（empty/oracle × 2 seed、有效性、
  重复一致、清理、重评）。"已接入"以 calibrate 报告为准。

## 3. 接入了哪些 benchmark

"可运行"= 能在其条件下运行；"校准"= 本机真实跑过 calibrate 或等价检查。**都不等于和官方分数对比过。**

| 大类 | Benchmark | 层级 | 可运行 | 校准情况 |
| --- | --- | --- | --- | --- |
| C1 固定输入 | HumanEval | L2 | 164/164 | 通过；oracle 全量 164/164 |
| C2 工作区 | Embodied First Exam（35 套件） | L0 | 1,938 / 2,260 | 只有 MetaWorld+ 两个任务；GPU 任务（pandadyn）因本机容器内 Vulkan 初始化失败未跑通 |
| C2 工作区 | Terminal-Bench Science / TB 4.0 | L0 | 70/70、56/66 | oracle/empty 抽样 |
| C2 工作区 | ASI-Bench、LongDS、ResearchClawBench、PostTrainBench | 内置 / L2 | 全部 | ASI 兼容性检查；LongDS 跑通一个完整 Codex 任务；后两者只有单测 |
| C3 工具 | BFCL multi-turn | L2 | 799/800 | 通过（四类 × 2 seed，离线重评） |
| C4 模拟用户 | τ²-bench airline / retail | L2 | 164/164 | 通过；**用户模拟器 LLM 未运行**（用的是离线重放） |
| C5 GUI | BrowserGym / MiniWoB++ | L2 | 125/125 | empty 全量；Claude Code 跑过 5 个抽样；Codex 截图/CLI 开发校准通过 |
| C5 GUI | CUA-Lite、Cua Bench | L2 | 子集 | MiniWoB 部分与 Cua 基础桌面任务通过；WebVoyager / Online-Mind2Web 需资产与 judge |
| C5 GUI | MobileWorld、OSWorld-V2 | L2 | 原版目录 | **未跑**（需要 KVM 真实校准） |
| C6 具身策略 | vla-eval LIBERO（libero_spatial） | L1 + L2 | 10 任务 × 50 初态 | 通过（empty）；**没有跑过真实 VLA policy** |
| C7 游戏 | TextArena 单人游戏（38 个） | L0 | 38/38 | 通过（4 游戏 × 2 seed） |

## 4. 适配了哪些 Agent / 方法

- **CLI Agent（注册表内置 12 个）**：codex、claude-code、pi、opencode、kimi-cli、gemini-cli、aider、goose、qwen-code、
  copilot-cli、mini-swe-agent、dsh；用户可在 `agents.json` 自定义。**真实跑通的只有 codex、claude-code、dsh**，其余 9 个标为 `unverified`。
  会话解析器只有 Codex 和 Claude Code 有。
- **GUI 能力**：Claude Code 经 `orbit-computer`（MCP/CLI 桥）完成过浏览器任务；Codex 经截图与 CLI 工具完成 MiniWoB 开发校准并启用 `gui`，签名证据经独立核验。GUI 运行需要容器可访问的模型连接；不代表桌面或手机后端已验证。
- **Policy / 外部模型**：`external` 方法（VLA policy 服务镜像、OpenAI 兼容端点）已实现，**都未用真实模型运行**。
- **校准方法**：`empty`（什么都不做）、`oracle`（参考解）、脚本方法——目前所有大类校准都只用它们。
- **认证**：每个 Agent 的 login / API key / relay profile；通知支持飞书（含 app 机器人）、钉钉、企业微信、Slack、webhook。

## 5. 没做好 / 缺口

**评测可信度（最重要）**
- 没有任何 benchmark 用真实 Agent / 模型跑出与官方结果对齐的分数（TB-Science 与 `harbor run` 的成对对比也没做）。
- 依赖 LLM 的部分没跑：τ² 的用户模拟器、C1 的 judge 类问答（SimpleQA 解析失败默认选 C 的吞错还没处理）、CUA-Lite 的 Web judge。
- 9 个 CLI Agent 未验证；Codex 缺 Harbor 的 `unified_exec`，GUI 实跑目前只验证了 BrowserGym/MiniWoB 浏览器路径。

**接入覆盖**
- C5 的 MobileWorld / OSWorld-V2 未在 KVM 上校准；C6 只有 LIBERO 一个原生 benchmark；C7 没有多人对局与 Elo 评分。
- EFE：GPU 任务受本机图形驱动阻塞；BEHAVIOR-1K 等需要授权数据卷（未支持）；部分套件需要 `cap_drop` 等未实现能力。
- Harbor 能力缺口：allowlist 网络（现以 public 代替并记为偏差）、多步任务、预声明 MCP 工具集、main 的 healthcheck。

**规模与资源**
- 多节点没有两台真机验证；同机多用户 daemon 可能同时租到同一张空闲 GPU（需要共享的每卡锁）。
- 暖池 / 实例账本（WebArena、OSWorld VM 复用）、批量 rollout、吞吐基准、导出（LeRobotDataset / ATIF）都未做。

**轨迹与 Web**
- 统一轨迹只覆盖 EFE MetaWorld+；浏览器没有回放和状态恢复；没有跨 benchmark 汇总视图。
- MCP server 本身未实现（只有 CLI + skill）；dsh / pi 没有会话采集。

## 6. 下一步可选方向（建议顺序）

1. **用真实模型做正向校准**（建议优先）：选 2–3 个已校准的样板（如 HumanEval、BFCL、TB-Science 抽样），
   用 Codex（gpt-6.1-sol）或 OpenAI 兼容 API 跑，与官方报告分数对比。这一步把"能跑"变成"分数可信"，也会暴露真实 Agent 下的新问题。
2. **补齐依赖 LLM 的评分路径**：τ² 用户模拟器、C1 judge 类问答（SimpleQA）及其无效映射。
3. **扩大覆盖**：EFE 更多套件的抽样校准；MobileWorld / OSWorld-V2 的 KVM 校准；C6 第二个原生 benchmark。
4. **规模**：有批量需求时再做暖池、批量 rollout、两台真机。

第 1 项成本最低、信息量最大；第 3、4 项在没有具体实验需求时可以继续后置。
