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

（实现后填写）

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |

## Next / open issues
