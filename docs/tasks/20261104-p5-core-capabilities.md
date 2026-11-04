# P5：资源与执行能力（设备、按卡型分配、结束阶段持久化）
branch: feat/p5-coverage · status: completed · updated: 2026-11-04 · owner: Codex（主线由 Claude 验收）

本文是交给实现者的任务书。完成后在同一文件补写 Changes / Validation，作为该 Part 的记录。
动手前按 [AGENTS.md](../../AGENTS.md) §1 读 design.md（§4 资源、§7、§9.4–§9.6、§9.13）、status.md
与 [research/embodied-bench/01-embodied-first-exam.md](../research/embodied-bench/01-embodied-first-exam.md) §6/§16。

## Goal

P5 的**核心能力**部分（不包含 GUI hub 适配器与 Web 视图，那两条在并行线 A/B）。三件事，按顺序做：

1. **结束阶段持久化**（design §9.6 第 7–8 条）：现在的停止流程是 `watch.ts` 里一串顺序调用，没有逐阶段记录、没有独立
   时限、daemon 重启后无法继续、取消时不能只跳过渲染而不跳过硬判定落盘。要让每个阶段可恢复、可审计。
2. **设备类**（§9.6 第 1–2 条）：KVM、`/dev/dri`、Android 这类设备不在资源账本里，OSWorld/MobileWorld/GFX 服务只能靠
   "假定整机独占"。加设备探测、租约与 `devices` 分配，让排队和放置认识它们。
3. **按卡型分配**：`gpuFeatures` 目前只进排队原因，不参与筛选（P4 的已知缺口）。按 GPU 名称做最小可行的过滤，
   并把 compose 的 `deploy.resources.reservations.devices`（EFE 的 GPU 服务写法）翻译成 service 的 `role` + `gpus`。

## 现状（动手前请核对）

| 位置 | 现状 |
| --- | --- |
| `runs/watch.ts` | `waitMain → hooks → collect → after → stopServices` 顺序执行；中止靠 `ctl.cancel`/`ctl.fail` |
| `runs/phases.ts` | `runHooks` 逐条执行但不记完成；`runAfter` 有 `run.after` 状态；`setAfter/skipAfter` 写库 |
| `runs/services.ts` `stopServices` | `Promise.all` 并行停服务，不按 `dependsOn` 逆序 |
| `runs/service.ts` 恢复路径 | daemon 重启后重新附着容器、继续等主命令（`watch(..., recovered)`），但阶段进度不持久 |
| `contracts/runs.ts` | `AfterStatus`；`RunSpec.volumes/volumeMounts/pidsLimit/entrypoint`；`ServiceSpec.role/gpus/gpuMemGB/gpuFeatures` |
| `resources/probe.ts` | 只探 GPU/CPU/内存/磁盘；`NodeResources` 无设备字段 |
| `resources/allocate.ts` | `allocateRoles` 已经按角色分卡，但 `gpuFeatures` 未参与筛选 |
| `bench/compose.ts` | `deploy.resources.reservations.devices` 会被报为不支持 |

## 设计（按此实现；有更好方案先写进本文）

### 1. 结束阶段（`Run.phases`）

新增契约 `RunPhase`：`{ name: "quiesce" | "finalize" | "render" | "collect" | "stop-services", state:
"pending" | "running" | "done" | "failed" | "skipped" | "timeout", startedAt, endedAt, deadlineAt?, exitCode?,
reason?, attempts }`，`Run.phases` 默认为空（旧记录可读）。

- 谁有渲染阶段由 spec 声明：新增 `RunSpec.after.render`（可选 `{ command, timeoutMin, collect? }`），或由 adapter 用
  现有 hooks 表达时排在 `finalize` 之后。EFE 的 collect hook 已经包含"先 finalize 再渲染视频"，此步只需**让它们可恢复**。
- 阶段执行器：`runs/phases.ts` 增加 `runPhased(ctx, id, phases)`——每个阶段先写 `running` + `deadlineAt` 再执行，结束写终态；
  已 `done` 的跳过（幂等）；超时按阶段 deadline 停；取消时 `finalize` 必须执行（写证据），`render` 标 `skipped`。
- `watch.ts` 用阶段执行器替换现有顺序调用；`collect` 与 `stop-services` 也纳入（取消时仍然采集）。
- **重启恢复**：daemon 重新附着运行中的 Run 时，按 `run.phases` 续跑：`running` 且容器仍在 → 继续等；容器已不在 →
  该阶段记 `failed`（原因"容器已消失"）并继续后续可执行阶段（`finalize` 已 done 就不会重跑）。
- 服务停止顺序：按 `dependsOn` 的逆拓扑顺序**串行**停止（`stopServices`），记录每步结果；某服务停不掉时把整组清理标为
  `failed`，租约不释放（现有规则不变）。

### 2. 设备类

- 契约：`DeviceClass = "kvm" | "dri" | "net-tun" | "android" | "serial" | string`（`string` 允许 `robot:<class>`），
  `NodeResources.devices: { class, count, exclusive?, detail? }[]`（默认 `[]`）。
- 探测（`resources/probe.ts`）：KVM（`/dev/kvm` 读写）、DRI（`/dev/dri/renderD*` 数量）、`/dev/net/tun`、`adb` 是否存在；
  用一个不依赖 root 的检查；探测失败记 `detail` 而不是让整个 probe 失败。
- 租约：`ResourceRequest.devices?: { class, count }[]`，`Lease.roles[].devices` 同样记录；分配时按"节点设备数 − 活动租约占用 −
  独占标记"判定，不足则排队并给出原因（与 GPU 同样的写法）。`exclusive` 的设备（如机械臂）同样走这个账本，一次只给一个 Run。
- 执行：`ContainerSpec.devices: string[]`（`--device` 逐项），service 与主容器都从角色分配取；`RunSpec.devices?` 与
  `ServiceSpec.devices?` 声明需求。`RunSpec` 校验：请求的设备必须在节点探测到（提交期给 FAIL，不进队列）。
- 显示：`orbit resources` / `ledger` / Web Resources 页显示设备与占用者（沿用 GPU 的展示方式，字段可为空）。

### 3. 按卡型分配与 compose GPU 服务

- `gpuFeatures`：`allocateRoles` 在候选卡上做**名称匹配**（`rtx` → 名称含 `RTX`，`egl`/`vulkan`/`cuda` 视为能力声明而
  不筛选，写进 reason 说明未校验）。匹配不到时排队原因写清楚（例如 "role sim: needs rtx, 0/2 matching cards free"）。
- compose：`deploy.resources.reservations.devices: [{ driver: nvidia, count: N, capabilities: [gpu] }]` → 该 service
  `gpus: N`（若该服务名与 `role` 约定一致——不要把任意服务都当角色；用 `role` 仅当该服务声明了 `x-orbit-role`，否则
  报"GPU 服务需要 x-orbit-role"）。`x-gpu-memory-gb` 同理映射到 `gpuMemGB`，仍不支持的键继续报 unsupported。
  EFE 的 `abc-sim` 任务可用来验收（先 `orbit bench tasks` 看是否从 unsupported 变为 supported）。

## 边界（必须遵守）

- **可改**：`packages/orbit/src/{resources,runs,executor,bench/compose.ts}`、`contracts/{runs,resources,cluster}.ts`、
  对应的 `cli` 显示（`orbit resources`/`ledger`）、Web `Resources.tsx`（只读展示）、测试、本记录、`docs/status.md` 相关行、
  design §9.6 的实现说明。
- **不改**：`contracts/bench.ts`、`bench/harbor.ts`、`bench/adapters/*`（并行线 A/B 在改 `examples/` 与 Web 的 trial 页面）、
  `packages/web/src/pages/bench/**`、`examples/bench-adapters/browsergym/**`。
- 不新增第二个状态机：阶段记录属于 Run，仍在 `RunService` 里推进；不加队列、不加新的 sqlite 表（如必须，用 `runs` 表已有
  的 JSON 文档字段）。
- 旧记录必须可读：所有新字段有默认值；旧 Run 的 `phases` 为空时按现有顺序执行。

## 验收

| 检查 | 要求 |
| --- | --- |
| `pnpm verify` | 通过；新增单测覆盖阶段执行器（幂等、超时、取消只跳 render）、设备分配、按卡型筛选、compose GPU 服务 |
| 阶段重启恢复 | 用测试注入：在 `finalize` 进行中重启 daemon（`RunService` 重新附着），`finalize` 不重复执行，证据保留 |
| 设备 | 本机 `/dev/kvm`、`/dev/dri` 探测结果出现在 `orbit resources`；请求不存在的设备在提交时 FAIL；两个 Run 争一个独占设备时第二个排队 |
| 按卡型 | 两台 3090 节点上请求 `rtx` 能分配，请求不存在的卡型时排队原因清楚 |
| EFE GPU 任务 | `orbit bench tasks` 中至少一个 `abc-sim` 场景从 unsupported 变为 supported，并跑通 oracle/empty（无 GPU 时如实记 not_run） |
| 清理 | 阶段失败/取消后无残留容器、网络、卷；租约只在清理确认后释放 |
| 记录 | 本文 Validation 逐项 passed / failed / not_run（附原因） |

## 交付

- 拆成三个提交：阶段持久化 / 设备 / 卡型与 compose；提交信息不加任何 AI 署名行。
- 完成后 rebase 到最新 main，`pnpm verify` 通过，通知用户；**合并由主线负责**。
- 补齐本文 Changes / Validation / Next，状态改为 completed。

## Changes

- 结束阶段存入既有 Run JSON：quiesce / finalize / render / collect / stop-services，各有状态、绝对 deadline、attempts 与事件；主命令退出码及取消意图同时持久化。
- hook / after / render 用容器内原子 claim、退出码和独立 watchdog；daemon 恢复先查询已执行命令，已完成阶段不重放。服务 hook 的私有状态目录单独挂载，支持只读根文件系统及非宿主 UID。
- 保持 Harbor 的 after 前 solve 产物快照；复制先写临时目标再替换，恢复不产生目录嵌套。服务逆拓扑串行停止，每步记结果，清理仍以实际删除确认决定租约释放。
- 实现细化：阶段时限由各 hook / after / render 配置和有界 Docker I/O 预算组合；已有 hook 中混合的 finalize 与视频命令仍是一个不可拆分步骤，只有显式 after.render 可单独跳过。旧 after 文件协议恢复时继续等待原命令。

- 设备类增加非 root 探测、诊断、具体路径与按角色租约；提交拒绝缺失设备，已占用设备排队，主容器和服务均使用已分配的 `--device`。CLI resources/ledger 与 Web Resources 展示容量与持有者。adb 只声明能力，不猜测 USB 映射。
- GPU 名称按大小写无关子串匹配，整组匹配不会让无型号限制角色占住唯一符合条件的卡；EGL/Vulkan/CUDA 明确为未验证声明。无角色服务的 CPU/内存也纳入准入。
- Compose 严格翻译显式 x-orbit-role 的 NVIDIA GPU reservation 与 x-gpu-memory-gb；未知键继续 unsupported。未改并行线的 benchmark 契约、Harbor adapter 或 trial 页面。

### 主线验收修正（Claude）

- 阶段回执、`after-durable` 标记与 `solve-collected` 移到 daemon 私有的 `runs/<id>/phase-state/`（0700，不在 `/orbit` 挂载内）；容器内进程无法伪造"已完成"。旧版 `after.exit` 只在 legacy 恢复时读取。
- 恢复时已过期的 `running` 阶段：带 `resumeMs` 的阶段（quiesce 60 s、collect 10 min、stop-services 按服务数）获得新的时间窗重试，而非直接记 timeout 丢证据。
- 重启后容器已消失且未记录退出码 → Run 记 `lost`（未知），不记 failed。
- quiesce 的时限计入 checkpoint 捕获预算；`copyFromContainer` 超过期限返回错误而不是抛出中断整个采集循环。
- KVM / DRI / TUN 为共享设备类（`NodeDevice.shared`）：只要求存在，不占用计数，多个 Run 与角色可同时使用；android 等仍按计数独占。

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | P5 integrated tree | passed | 格式/lint、类型、边界、532 项测试、Web/CLI 构建；21 项 opt-in 测试默认跳过，真实阶段测试单独执行 |
| 阶段单元与恢复注入 | P5 integrated tree | passed | 显式 executor doubles：幂等、失败/超时后继续采集、取消跳 render、绝对 deadline、RunService 重新附着 |
| 真实 Docker 阶段 | P5 integrated tree | passed | 4 场景：主容器停止后服务 finalize 中重启不重复主 hook、取消保留 verdict、TERM-resistant 子进程超时、服务逆序与网络/卷清理；临时状态目录亦清理成功 |
| 设备与 GPU/Compose 回归 | P5 integrated tree | passed | 缺失设备提交拒绝、独占槽位排队、跨路径冲突、型号/显存/ID 匹配、严格 Compose 正负例；资源/placement doubles 明确为测试注入 |
| 真实设备 / GPU / CLI | P5 integrated tree | passed | 独立 daemon + 实际 probe：resources/ledger 显示设备、未知设备拒绝、TUN 容器映射与争用排队、取消后释放、RTX 服务 nvidia-smi 映射与租约一致、未知型号排队、全部自建资源清理 |
| 两台物理节点 GPU 放置 | — | not_run | 本次真实验证在单节点执行；多节点路径保留单元测试覆盖，未配置第二台物理执行节点 |
| 原版 EFE abc-sim 任务枚举 | P5 integrated tree | passed | 如实保持 unsupported：sim/rcb_monitor 缺 x-orbit-role；只增加角色的开发副本可枚举 supported，但独占 GPU 条件不同，不视为原版对齐 |
| 原版 EFE GPU oracle / empty | P5 integrated tree | not_run | 原版缺角色且假定共享 GPU，与本任务明确角色/独占规则冲突；ABC 仿真镜像未安装，不修改上游任务或静默放宽条件 |
| 主线验收修正 | feat/p5-coverage (review fix) | passed | `pnpm verify`：orbit 480 passed / 21 skipped，web 51；新增伪造回执被忽略、过期阶段续跑、容器消失记 lost、共享设备不消耗四项回归 |
| 主线核对 | 4993f5f | passed | fetch 后 main 与 origin/main 均为当前三提交的直接基线；无需移动提交，未推送或合并 |

## Next / open issues

- 主线验收三个提交；合并由主线负责。
- EFE GPU 原版校准需先确定 sim/monitor 的显式角色和 GPU 共享语义，再准备固定镜像执行 oracle/empty。
- 旧记录可读；升级前没有 durable hook 标记的已执行操作无法追溯防重。混合 finalize/video 的旧 hook 只能整体恢复；独立取消渲染需显式 after.render。
