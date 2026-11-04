# P5-A：GUI hub 外部适配器（并行线 A）
branch: feat/p5a-gui-hub-adapters · status: in_progress · updated: 2026-11-04 · owner: Codex（主线由 Claude 负责）

本文是交给实现者的任务书，完成后在同一文件补写 Changes / Validation，作为该 Part 的记录。
动手前按 [AGENTS.md](../../AGENTS.md) §1 阅读 design.md（重点 §7 适配器协议、§9）、status.md、
[guides/bench-adapter.md](../guides/bench-adapter.md) 与 [research/gui-bench/](../research/gui-bench/)。

## Goal

把以下 GUI hub 以**外部适配器**（`examples/bench-adapters/<name>/`，与 browsergym、longds 同一形态）接入 Orbit，
保持上游原版的环境、任务、动作语义与评分器，不在 Orbit 核心里重新实现它们：

| 顺序 | hub | 固定版本（本机已 clone） | 首批范围 |
| --- | --- | --- | --- |
| 1 | Cua Bench（`/disk/disk_20T/wangxuehai/cua/libs/cua-bench`） | `2829e00b1` | 3 个 registry taskset 中 Linux 容器可运行的（cua-bench-basic 起步） |
| 2 | CUA-Lite（`/disk/disk_20T/wangxuehai/cua-lite`） | `2af6926` | 先接不需要 KVM 的浏览器套件（MiniWoB++ 对照 Orbit 现有 BrowserGym 结果、WebVoyager/Online-Mind2Web 中无需登录的部分）；桌面/移动套件列出但标 unsupported 并写原因 |
| 3 | MobileWorld（`/disk/disk_20T/wangxuehai/MobileWorld`） | `a026188` | 单任务调用原版 `mw eval`；GUI-only 任务；需要 KVM |
| 4 | OSWorld-V2（`/disk/disk_20T/wangxuehai/OSWorld-V2`） | `d995367` | 单任务调用原版 runner；需要 KVM 与 VM 镜像 |

做不完时按顺序交付，后面的留在 Next；不要为了数量降低条件。

## 边界（必须遵守）

- **只改**：`examples/bench-adapters/<新目录>/`、`docs/guides/`（可新增一份 GUI hub 使用指南）、本任务记录、
  `docs/status.md` 的相关行、必要时 `packages/orbit/test/example-adapters.test.ts`。
- **不改**（主线正在改，冲突风险高）：`packages/orbit/src/{resources,runs,cluster,executor,bench}/**`、
  `packages/orbit/src/contracts/{runs,resources}.ts`、`bench/compose.ts`、`bench/harbor.ts`、`packages/web/**`、
  `examples/bench-adapters/browsergym/**`（归并行线 B）。确需核心改动时：不要自己改，在本文 Next 写清楚需求与理由，
  由主线实现。
- 一个 Orbit trial = 一个任务的一个 episode。**禁止** hub 内部再开并发（关掉 `--parallel`、`-n`、多 worker 等，固定为 1），
  否则会绕过 Orbit 的资源账本（design §9.6 第 4 条）。
- hub 自己的队列、SQLite、结果目录续跑一律不用；结果作为产物导入（design §9.0）。
- 不在条件改变的情况下运行：缺依赖、需要登录/外部账号、共享后端的任务，列出并标 `supported: false` 写明原因。
- 密钥只走 Method `passEnv` / benchmark `passEnv`，不进 config、日志、产物、提交。

## 实现约定

参照 `examples/bench-adapters/browsergym/` 与 `longds/`：

1. **执行方式**：hub 自己启动容器/VM 时，用 `backend: "process"` 运行其原版单任务入口；Orbit 的 docker shim 会给子容器
   打 `orbit.parent` 标签并在清理时回收。资源在 solve spec 里如实申请（CPU/内存要覆盖 VM 或模拟器本身）。
   KVM：在 `tasks` 里检查 `/dev/kvm` 可读写，不可用时任务标 unsupported（原因写明）；当前 Orbit 账本不登记设备，
   在 `capabilities.conditions` 写明"KVM 不在 Orbit 账本中，依赖主机独占"。
2. **Method**：支持 `external`（hub 自带的 agent/模型，`entrypoint` + `config`）与 `empty`；有官方参考解或脚本正例时
   提供 `oracle` 或在 README 写明"校准用脚本正例"（design §9.10 L1 定义）。CLI Agent（`cli`）不在本线范围（并行线 B 负责桥）。
3. **tasks 回复**：`capabilities`（kind、methods、conditions：版本、观测、动作空间、步数上限、过滤规则）、`metrics`、
   以及该 hub 自己的统计口径 `official`（design §9.7；例如是否把基础设施错误计入分母——先读上游源码确认，不确定就不声明）。
4. **score 回复**：用上游评分器的原始结果；评测异常给 `invalid: true` + `failure`（封闭集合，见 `contracts/bench.ts`
   `FAILURE_KINDS`），不要转成 0 分；交互 episode 给 `episode`。原始结果文件（上游的 result.json、traj.jsonl 等）放进
   solve/verify 输出并在 `review.files` 里列出；GUI 轨迹能转换为 `GuiTrajectory`（`kind: "trajectory"`）就转换。
5. **固定版本**：适配器校验上游 checkout 的 commit 与无改动（参考 browsergym `checkout_revision`）；镜像尽量用 digest。
6. **测试**：每个适配器带 `test_adapter.py`（明确的文件 fixture，不冒充真实运行），`python3 -B -m unittest` 可跑。

## 验收（每个 hub）

| 检查 | 要求 |
| --- | --- |
| 单元测试 | 适配器 `unittest` 通过；`pnpm verify` 通过 |
| tasks | `orbit bench add` + `orbit bench tasks` 列出全部任务，unsupported 有原因 |
| empty | 隔离 daemon（`ORBIT_HOME=<临时目录> ORBIT_PORT=<空闲端口>`）中抽样 ≥5 个任务：全部 valid 0 分（或该 bench 声明的负校准值） |
| 正校准 | 有 oracle / 脚本正例 / 官方 baseline 时抽样跑，得到声明的期望值 |
| 失败路径 | 至少一种注入故障（评分器异常或环境启动失败）被判为 invalid 且 `failure` 正确，不是 0 分 |
| 清理 | 运行与取消后无残留带 `orbit.parent` 标签的容器/网络/卷 |
| 记录 | 本文 Validation 表逐项写 passed / failed / not_run（附原因）；README 写准备步骤与已知偏差 |

KVM / 大镜像 / 外网导致无法真实运行时，如实记 not_run 与原因，不用 fake 结果代替。

## 交付

- 每个 hub 一个提交（`feat(examples): add <hub> adapter`），提交信息不加任何 AI 署名行。
- 完成后：rebase 到最新 main，`pnpm verify` 通过，通知用户；**合并由主线负责**，不要直接推送 main。
- 本文的 Changes / Validation / Next 补齐后状态改为 completed。

## Changes

- 新增 Cua Bench 外部 adapter：原版任务工厂发现 145 个本地变体；首批映射 68 个 basic Linux 变体。原版 Docker SDK 绕过 CLI shim，因此使用 Orbit service 持有固定桌面镜像，再通过原版 Sandbox.connect / RemoteDesktopSession.attach / run_episode 单 episode 路径接入；没有核心修改。
- token 仅存于不收集的专属卷；桌面服务、私网、卷统一由 Orbit 清理。任务列表检查固定干净源码、runc、已准备客户端与桌面镜像；不满足则 unsupported。
- 保留原始 evaluator reward 和失败分类（与 EpisodeResult.success 分离），提供原版 ATIF、明确时序的 GUI 帧及证据校验。固定源码、原版桌面 digest、客户端包版本和基础镜像 digest；详见两个 adapter README。
- Cua tasksets 是 2829e00b1 checkout 的原版 datasets，不宣称等于 registry 1.0 指向的 6762bcf63 内容。runc、每 Run 私网替代 host loopback、服务资源和上游忽略的显示背景条件均明确记录。

- 新增 CUA-Lite 外部 adapter：125 个原版 MiniWoB 任务、943 个 WebVoyager / Online-Mind2Web 原版任务条目及 15 个明确标为 suite availability 的未接通套件行；仅 MiniWoB 可运行。容器私有原版 HTML 服务、原版 gym.make / agent.sample、一次 reset、截图 / canonical action / 原始 terminal reward；无新增 agent 循环或 hub 并发。
- CUA-Lite 固定 Python 3.12 / BrowserGym 0.14.3 / Playwright 1.44.0 / MiniWoB commit；最小客户端补齐 jsonschema finish 工具依赖。保留原版截图、归一化坐标与原版 30 秒页面 budget；与标准 BrowserGym 条件不同，截图脚本正例不冒充通用 oracle。

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Cua 文件 fixture / RunSpec schema | 当前分支 | passed | 8 个 Python fixture 测试；服务 healthcheck 使用真实 command argv，私有 token 卷不进入 collect；TypeScript 规划校验通过。并非真实桌面结果。 |
| Cua 注册 / tasks | cua 2829e00b1 | passed | 隔离 daemon 的 bench add/tasks 枚举 145 个变体；镜像未准备时全部明确 unsupported，准备后首批仅 basic 68 个可选。 |
| Cua 客户端镜像 | cua SDK 0.10.1 / bench 0.3.1 | passed | Orbit 构建并真实 import；固定原版源码只读挂载。实际客户端 imageId 4310967a1b23…；不等同桌面验收。 |
| Cua ≥5 empty / oracle / 故障 / 服务清理 | cua 2829e00b1 | not_run | 固定原版桌面 digest 正在外网拉取；尚未启动真实桌面，不宣称校准完成。 |
| CUA-Lite 文件 fixtures | lite 2af6926 | passed | 5 个明确文件 fixture 测试：原版 reward / final verdict、异常 invalid、篡改、trial identity、单 episode 规划；不代替 Chromium。 |
| CUA-Lite 注册 / tasks | lite 2af6926 / MiniWoB 7fd85d7 | passed | 独立 ORBIT_HOME / ORBIT_DATA / 空闲端口；bench add/tasks 1083 行，125 supported；其余有明确原因。 |
| CUA-Lite ≥5 empty | 同上 | passed | click-test / click-button / click-dialog / enter-text / choose-list 原版 Chromium 均 valid 0；对应开发检查 20261104-110201-ekcn。 |
| 与现有 BrowserGym 开发校准对照 | BrowserGym 0.14.3 / Lite 2af6926 | passed | 补跑 click-checkboxes（20261104-110904-en3d）valid 0，与 B 线 click-test / click-button / click-checkboxes / enter-text / choose-list 五个 empty 的原版奖励一致；页面 budget / 动作和正例观测权限不同，不声明同条件性能等价。 |
| CUA-Lite 截图脚本正校准 / rescore | 同上 | passed | click-test 原始奖励 valid 1；离线证据重评仍 valid 1、保留历史；20261104-110202-ns9d。脚本仅使用原始截图，不是模型 baseline。 |
| CUA-Lite 环境故障注入 | 同上 | passed | 故意提供 Python 3.11 客户端：原版环境无法导入，invalid / env_start / score=null；20261104-110203-r5fy。开发中缺 jsonschema 亦 invalid / env_step，补依赖后负校准通过。 |
| CUA-Lite 取消 / 清理 / GUI 证据 | 同上 | passed | 真实 reset 后等待策略取消：execution cancelled、evaluation unknown、cleanup done；20261104-110240-kp4g。21 个相关 Run 的 orbit.run / orbit.parent 容器、网络、卷为 0；实际截图路径和 GuiTrajectory schema 通过。 |
| CUA-Lite 客户端镜像 | Python 3.12.16 / Playwright 1.44.0 | passed | 开发验收复用只读 BrowserGym 系统层，加入相同 Bookworm Python 3.12 和固定依赖；真实导入、Chromium、评分均通过；最终 imageId a240b2b6b967…；未改用户/B线镜像。 |
| 通用外部模型 Agent | 两个 hub | not_run | 已实现原生注册 Agent / 自定义入口；真实校准覆盖脚本 external，未验证通用模型。CLI Agent 不属本线。 |
| CUA-Lite 独立标准 Dockerfile 重建 | 固定 Python digest / dependencies | not_run | 早期浮动 Debian 基础不兼容已修正；Bookworm 全量 apt 下载过慢取消，实际校准用上述语义相同的派生镜像。独立标准文件未重跑完整构建。 |
| 构建阶段自动取消 | Orbit 4184d4c | failed | starting/build 取消未中止构建；仅对明确自有 CLI 温和终止后，Orbit cleanup done、lease released。见 Next，不能计为自动取消通过。 |
| 全仓库检查 | 本线代码 / main 4184d4c | passed | pnpm verify（格式、lint、类型、模块边界、tests、build）通过；交付前 rebase 后再检查。 |
| MobileWorld / OSWorld-V2 | a026188 / d995367 | not_run | /dev/kvm 不存在；未接通独立 adapter，不用 fake 或软件仿真替代。 |

## Next / open issues

- Cua 原版桌面实际校准仍待完成；KiCad / workflows 应用依赖与账号条件未映射，继续 unsupported。
- CUA-Lite MiniWoB 已接通；WebVoyager（原版 WebHarbor 回放服务）、Online-Mind2Web 的独立后端 / judge / 登录过滤不能在条件未映射时启用。
- MobileWorld 与 OSWorld-V2 按顺序留后续；本机 /dev/kvm 不存在，禁止悄悄启用软件仿真。MobileWorld 须原版 mw eval 单任务、max-concurrency=1、pass-k=1、auto-retry=0 并只用本 trial 拥有的模拟器。OSWorld Docker provider 使用 SDK 创建无标签容器，CLI shim 不足；需主线提供可审计生命周期/标签配置，并使被原版吞为 0 的 evaluator 异常可分类为 invalid。
- 核心取消构建缺口：Run 处于 starting/docker build 时重复 orbit cancel 仍继续构建并保留租约；本次明确核对任务 build CLI 的父 PID / 唯一 tag 后仅发一次 SIGTERM，由 Orbit 终结为 failed、cleanup done、lease released，无对应构建 CLI 残留。这是人工清理，不是自动取消通过；主线应将构建 / 拉取的 AbortSignal 贯通。
