# P3：BrowserGym 全套与 EFE 原条件任务
branch: feat/p3-browsergym-efe · status: completed · updated: 2026-11-04

## Goal

design §9.13 P3：两个小而完整的接入。BrowserGym 从 5 个校准任务扩到全部 MiniWoB++；接入一个保持原条件的
Embodied First Exam（EFE）CPU 任务，先列兼容清单（§9.6 第 0 条），把缺口补进核心而不是删改任务。

## Changes

- **BrowserGym**（`examples/bench-adapters/browsergym/`）：任务清单改为 `miniwob_tasks.json`（browsergym-miniwob 0.14.3
  `ALL_MINIWOB_TASKS` 的 125 个任务，由镜像内生成）；未注册的 HTML 标 unsupported。`-c suite=` 对 WebArena、
  WebArena Verified、VisualWebArena、WorkArena、AssistantBench 明确拒绝（共享网站后端，Orbit 尚无独占调度）。
- **EFE 兼容清单**（MetaWorld+ `metaworldplus-assembly-i00-standard`，eai-standard/2.1，CPU）：原版 15 项不支持。逐项处理：
  - 核心新增：compose 顶层与服务 `volumes`（命名卷随 Run 创建、带 `orbit.parent` 标签、清理时最后删除；任务目录内 bind）、
    `restart`、`network_mode: none`、`main` 的 `volumes` 与 `pids_limit`、服务名允许 `_`；`ServiceSpec` 增加
    `volumes / binds / restart / hostPid / hostCgroup / noNetwork`，`RunSpec` 增加 `volumes / volumeMounts / pidsLimit`。
  - 登记时开启并记为偏差：`-c hostNamespaces=allow`（资源监控 `pid/cgroup: host`）、`-c allowlistNetwork=public`
    （allowlist 按公网运行）；整值 `${VAR:-d}` 模板取默认值。偏差写入任务 tag `deviations`，并作为 `deviation: …`
    issue 记在每个 trial 上。
  - harbor reward：`reward.json` 有多个值且无 `reward` 时取 `reward.txt`（与 EFE 协议一致）；`infra_error` / `grader_error`
    为真时判 invalid（failure `infra` / `scorer_error`），不记 0 分。这是真实运行发现的问题。
- 文档：design §7 compose 与 harbor 选项；BrowserGym README；并行线任务书
  [P5-A](20261104-p5a-gui-hub-adapters.md)、[P6](20261104-p6-cli-agent-bridge.md)。

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | working tree | passed | 422 orbit（17 skipped）+ 51 web |
| BrowserGym `unittest` | working tree | passed | 15 tests，含全量清单与后端套件拒绝 |
| MiniWoB 全量 empty（隔离 daemon，真实 Chromium） | working tree | passed | 125/125 valid 0 |
| EFE 任务列表 | working tree | passed | 原版 15 项不支持 → 登记选项下 supported，3 条偏差列出 |
| EFE oracle / empty 真实运行（MuJoCo sidecar + monitor + separate verifier） | working tree | passed | 首次评分发现 reward.json 解析问题（两者 invalid）；修复后对保存证据 rescore：oracle 1、empty 0，均 valid；sidecar `graded_by: live`；报告修订 1→2 |
| EFE 第一次尝试 | working tree | failed | 镜像拉取超时（本机代理慢），与 Orbit 无关；预拉 5 个固定镜像后重跑 |
| 清理 | working tree | passed | 本 home 无残留容器、网络、命名卷 |
| allowlist 出口过滤 | — | not_run | 未实现；以公网运行并记为偏差 |
| EFE GPU 任务、realtime 模式、真实 coding agent | — | not_run | GPU 随 P4；Agent 桥随 P6 |

## Next / open issues

1. allowlist 网络（按主机名放行出口）未实现，目前只能以偏差方式运行 EFE 的 agent 阶段。
2. `pid/cgroup: host` 的监控容器能看到本机全部进程；只在登记显式允许时使用。
3. BrowserGym 后端套件需要共享实例互斥（P7）后再接。
