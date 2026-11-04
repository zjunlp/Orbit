# P6.5：接入层（覆盖盘点、自动校准、Harbor GPU 补全、L1 清单、L2 SDK）
branch: feat/p65-integration · status: completed · updated: 2026-11-04 · owner: Claude

## Goal

落实 design §9.14：让新 bench 按 L0（Harbor）/ L1（声明式清单）/ L2（SDK）接入；"已接入"以自动校准报告为准；
大型 hub 的覆盖有依据可查；按覆盖缺口排名补 Harbor 能力。

## Changes

- `orbit bench coverage <bench>`：纯函数 `contracts.benchCoverage`，按 suite（Harbor 取 `tasks/<suite>/<task>`，新增
  `suite` tag；其余取 id 前缀）统计 supported，原因去掉服务名与变量说明后计数排序。CLI only，无新 API。
- `orbit bench calibrate <bench>`（`cli/calibrate.ts`）：按 suite 轮转抽样，empty（+ oracle，benchmark 允许时）× 2 seed，
  七项检查：完成、valid、empty=0、oracle 满分、重复一致、清理确认、保存证据重评一致；任一 FAIL 退出码 1。只用公开 client API。
- Harbor / compose GPU：首次 EFE 扫描显示 1,294 个任务因"GPU 服务需要 x-orbit-role"不可运行。实际写法是 Compose 单机语义
  （所有 `count: N` 拿同样的前 N 张卡，监控容器借此测主体的显存）。改为：无 `x-orbit-role` 的 reservation 组成一个共享组，
  `main` 有 reservation 时由 main 租用（privileged），否则第一个不在宿主命名空间的服务成为同名角色（standard 的 sim）；
  其余成员用新字段 `ServiceSpec.gpusOf` 看到同一组卡而不额外租用；组内 count 必须一致，`x-gpu-memory-gb` 求和。
  带 `x-orbit-role` 的仍独占。
- `[environment] gpu_types` → 拥有该组的角色的 `gpuModels`（新字段 `ResourceRequest.gpuModels` / `ServiceSpec.gpuModels`，
  任一型号，名称包含匹配；本机无对应型号时提交即给出原因；`-c gpuTypes=any` 不限制并记偏差）。main 的 `shm_size` →
  新字段 `RunSpec.shmGB`；服务的列表 `entrypoint` 拆成可执行文件与前置参数。
- L1：内置 `manifest` 适配器（`bench/manifest.ts`）读 `orbit-bench.yaml`：镜像、任务表或镜像内列举命令、staging 文件模板、
  各方法（empty/oracle/external）的 Run、结果文件选择（路径 + reduce）、`invalid` 规则 → 封闭失败类型。模板 `{{…}}`、
  `{{json:…}}`、`{{argv:…}}`；挂载与 bind 只能在清单目录内。样板 `examples/bench-manifests/vla-eval-libero` 与 Python 版
  vla-eval 适配器条件相同。`AdapterHandlers.info` 让内置适配器声明 capabilities / official。
- L2：`examples/sdk/orbit_bench`（stdlib）：`main`（协议校验、JSON、stderr + 非 0 退出）、`valid` / `invalid`（只接受封闭失败
  类型，TS 测试核对与契约一致）、`pinned`。9 个 Python 适配器入口改用它；顺带修复 vla-eval 出错仍以 0 退出。
- design §7 / §9.6 / §9.14、`guides/bench-adapter.md`（§2a 清单、SDK、校准）同步。

### 独立审查修正

- 清单：结果路径选不到值时判 `scorer_error`，不会因 `count` / `any` 变成有效 0；方法覆盖 `solve` 时 `resources` 与 `env` 按键合并；
  结果文件只读普通文件（不跟随运行写的链接），多文件匹配写 issue；任务列举按镜像 + 清单缓存在用户私有临时目录，列举容器带
  `orbit.manifest-tasks` 标签、2 CPU / 4 GB 限制，100 s 未完成即删除（不再每个 trial 起一个无标签容器）。
- GPU 型号按名称整词顺序匹配（`L4` 不匹配 L40S，`A10` 不匹配 A100）；`gpu_types` 作用于任务拿到的每张卡（main 与每个 GPU 角色）；
  `[environment] gpus` 与服务拥有的共享组同时出现时报不支持（否则 Agent 会多拿一张卡）。
- calibrate：只把真正重评的 trial 计入"重评一致"，被跳过的（worker 上的 solve 等）记 not_run 并注明。

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | 1aa8292 | passed | Orbit 576 / 26 skipped、Web 62；新增 GPU 共享/型号/shm/entrypoint、coverage、calibrate 判定、manifest、SDK 失败类型一致性测试 |
| Python 适配器与 SDK 单测 | 1aa8292 | passed | 9 个适配器 `unittest` 通过（cua-lite 3、osworld 2 项依赖上游的 skipped）；SDK 3 项；每个入口对坏请求非 0 退出 |
| EFE 覆盖（真实 daemon + CLI） | 48cd26a | passed | 原版 EFE checkout：1,938 / 2,260（86%）可按条件运行，修正前 953（42%）；剩余为授权数据卷（BEHAVIOR、ManiGuard、BlenderKit）、main `cap_drop` / `healthcheck` |
| EFE MetaWorld+ 自动校准（真实 Docker） | 48cd26a | passed | 2 任务 × empty/oracle × 2 seed：7 项全部 PASS（empty 0、oracle 1、重评一致、清理确认） |
| vla-eval LIBERO 清单（真实 Docker） | 1aa8292 | passed | 镜像内真实列举 10 个 libero_spatial 任务；2 任务 × empty × 2 seed 校准 PASS（valid 0，与 Python 适配器 P4 结果一致），oracle 不适用 |
| 审查修正 | fix/p65-review | passed | `pnpm verify`：Orbit 582 / 26 skipped；新增空选择、按键合并、整词型号、gpu_types 全角色、歧义 GPU 布局、跳过重评回归；LIBERO 清单真实列举 10 任务、无残留列举容器 |
| EFE GPU 共享任务真实运行 | — | not_run | pandadyn 基础镜像拉取过慢（>25 分钟未完成）；共享组、gpusOf 与型号限制由单测覆盖，真实检查见后续记录 |
| 授权数据卷任务 | — | not_run | 本机没有 BEHAVIOR / ManiGuard / BlenderKit 数据 |

## Next / open issues

- EFE standard GPU 任务（sim + monitor 共享卡）真实 oracle/empty；本机为 3090，带 `gpu_types` 的任务需 `-c gpuTypes=any`（偏差）。
- 授权数据卷：登记时把变量绑定到用户数据目录（只读），再补 main `cap_drop` / `healthcheck`。
- 其余 GUI adapter 的内部逻辑可逐步改用 SDK 的 `valid` / `invalid`；跨 bench 汇总视图（只并列，不平均）。
