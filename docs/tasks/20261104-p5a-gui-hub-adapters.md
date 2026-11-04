# P5-A：GUI hub 外部适配器（并行线 A）
branch: feat/p5a-gui-hub-adapters · status: blocked · updated: 2026-11-04 · owner: Codex（主线由 Claude 负责）

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

- Cua Bench：保留固定源码的 145 个本地变体，首批 68 个 basic Linux 变体可选。Orbit service 持有原版固定 digest 桌面，原版 Sandbox.connect / RemoteDesktopSession.attach / run_episode 执行一个 episode；token 留在不收集的私有卷。真实检查修复原镜像把卷误认作 Fleet 密钥来源的问题，使用原生 `CUA_ENV_AWAIT_TOKEN_FILE=0` 本地生成模式。
- Cua 关闭连接与可选媒体转换错误单独记录，不覆盖原版 reward 或已有失败；保存 ATIF、原始结果、GUI 帧与证据重查。源码 tasksets 不冒称等于 registry 1.0 的另一 revision；runc、私网及上游显示背景条件见 README。
- CUA-Lite：125 个 MiniWoB、943 个 Web 原版任务与 15 个 suite availability 行全部保留。补齐 WebVoyager / Online-Mind2Web 各五个明确审查的免登录只读任务路径，每 trial 一个独立原版后端、instances=1；其他任务说明过滤原因。固定客户端依赖及 Online 后端的 Playwright/FastAPI/Uvicorn/Pydantic，镜像 source/suite/version 标签与 immutable image ID 一起检查。Online 准备固定 SHA 的根文件/代码，省去服务不读取的参考图片；原 server、任务和 judge 未改，构建布局有显式条件/标签。
- Web 原版 terminal judge 放在 Orbit 既有 after 阶段：终止时捕获原版输入，策略退出后调用原 `_evaluate`，benchmark judge key 不进入策略或服务。保留原始 reward/info；缺 key、无法解析的 verdict、无效 image judgment 都判 invalid。真实浏览器检查修复 Web empty 的结束方式：使用原版 Agent 内部 final action，保持默认 extra_tools 不变。明确记录延迟终局评分条件；当前 after trial 不支持 rescore，含 Web 后端的注册声明 `rescore=none`，MiniWoB 可单独注册并重查。
- MobileWorld：发现 201 个原版任务类；GUI-only、原版 `mw eval`，concurrency=1、pass-k=1、任务与设备重试均为 0。仅创建本 trial 的固定镜像模拟器，使用 Orbit shim 标签与清理；缺失/非有限原版评分拒绝为 invalid。
- OSWorld-V2：保留 osworld-v2.1 release 的 108 个任务与哈希清单，校验原版 gated tasks、assets、VM archive 和 runtime image。调用原 `run_single_example`、一个 VM/reset/final evaluate；Docker SDK 7.1.0 的创建边界仅允许一个已知 VM，补齐归属标签、资源上限和本机端口。捕获原版吞成零分的 evaluator 异常，不使用软件仿真。
- Mobile/OS 保留原始结果并转换已有 GUI 帧，按原版截图时序配对动作，不捏造缺失末帧；已知 passEnv 文本值脱敏后再记录证据哈希。seed 仅记录身份，未假称原版提供任务 seed 接口。没有修改 Orbit 禁改核心目录。

## Validation

提交号引用 rebase 后的等价实现；真实环境检查基线为 main 4184d4c，最终仓库检查为 main 4993f5f。

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Python / 跨语言协议 | 本次复查 | passed | Cua 10 项；Lite 原版函数 opt-in 20 项；Mobile 9 / OS 12 项。包括明确文件、API、provider 响应 fixture，不能代替真实浏览器/模型/VM。13 项 TypeScript 集成检查覆盖 adapter、RunSpec、score 与 GuiTrajectory。 |
| Cua 注册 / 原版镜像 | cua 2829e00b1 | passed | 独立 daemon add/tasks：145 条、68 个 basic 可选。原 index、manifest、config 与所有镜像层 SHA256 校验；完整原 repo@digest 可 inspect，真实 service 使用该引用。客户端真实 import 已通过。 |
| Cua ≥5 empty / oracle | cua 2829e00b1 | passed | click-button、click-icon、color-picker、typing-input、toggle-switch 的 @0：五条 empty 均 valid 0，五条原版 oracle 均 valid 1；原版 ATIF、PNG、十条 GUI schema/文件检查通过。开发校准不是模型性能结论。 |
| Cua 失败路径 / 取消 / rescore | 同上 | passed | 真实环境中的 evaluator 故障注入为 invalid/scorer_error/score=null；close 故障注入保留 valid 0 并记录两项关闭错误。reset 后取消为 cancelled/unknown，cleanup done；正例重查仍 valid 1，原 solve 不变、history=1。 |
| Cua 清理 | 本次隔离检查 | passed | 33 个 Run 全终态、cleanup done、lease released；对应容器/网络/卷为 0，独立 daemon 已停止，运行证据保留。 |
| Cua token 采集边界 | 固定原版镜像 / 本次产物 | passed | 检查实际服务/Run 日志、ATIF 与输出文件，未发现秘密值模式或未归属的 token 格式字符串；固定镜像生成脚本直接写私有卷、不输出值。原卷已清理，未声称完成实际 token 精确值比对。 |
| CUA-Lite MiniWoB 注册 / empty | lite 2af6926 / MiniWoB 7fd85d7 | passed | 首次隔离注册 1083 行、125 supported；click-test / click-button / click-dialog / enter-text / choose-list，加补充 click-checkboxes，原版 Chromium 均 valid 0。与 B 的五个同名任务负校准一致；页面 budget、动作与正例观测权限不同，不宣称同条件性能等价。 |
| CUA-Lite MiniWoB 正例 / 失败 / 清理 | 同上 | passed | screenshot-only click-test 原始奖励 1、证据重查仍 1。故意不兼容的 Python 3.11 环境为 invalid/env_start/score=null；真实 reset 后等待策略取消为 cancelled/unknown、cleanup done。首次 34 Run 清理与 GUI 证据检查通过，隔离 daemon 已停止。 |
| CUA-Lite 标准客户端构建 | `8270f3c` / Python 3.12 | passed | 固定 Dockerfile 全量构建完成；拆分 pip/系统依赖/browser 缓存层，准备下载采用有界重试，不改变 episode 或固定依赖版本。独立构建 Run 20261104-144336-xhbm succeeded、cleanup done；标准镜像原版接口检查 20/20 passed，无 skip。 |
| CUA-Lite 标准镜像真实回归 | `8270f3c` / lite 2af6926 | passed | click-test / click-button / click-checkboxes / enter-text / choose-list 五个 empty 均 valid 0；截图脚本 click-test valid 1，rescore 仍 1 且保留 history。六个 episode 均只 reset 一次，native/saved/outcome reward 一致，六份真实 GuiTrajectory schema 通过。该隔离 home 的 19 Run 全终态、cleanup done，已分配租约 released，无 orbit.run/orbit.parent 容器/网络/卷，daemon 已关闭。 |
| Web 原版评分边界 | lite 2af6926 | passed | Python 3.12 的原类/函数检查包含 no-answer、缺 key、无法解析的最终 verdict 和 image relevance fallback；使用明确图像/provider fixture，无模型调用。两套 after 规划通过真实 RunSpec，原始评测输入和输出仍保留。 |
| Online-Mind2Web 后端 / 真实无 key 检查 | lite 2af6926 / `e632d53` | passed | 固定源码、依赖和 sparse code 布局的原版后端完整构建成功。真实 arXiv empty 与 scroll smoke 均完成 reset PNG、原版动作、terminal capture，进入原 judge；execution succeeded、evaluation invalid、score=null、failure=judge_unavailable、cleanup done。服务 max_instances=1；无模型调用，不计为有效负校准或模型正例。 |
| Online 取消与资源清理 | 同上 | passed | 真实 reset checkpoint 后取消：cancelled/unknown、cleanup done；最终租约/队列均为 0，对应容器/网络/卷为 0，17844 隔离 daemon 已停止。 |
| Online live-site 可达性 | 同上 | failed | 另一次真实 GitHub 页面在原导航 20 秒上限超时，准确保留 invalid/reset_failed；未换站点条件、关闭 TLS 或记成有效零分。后端完整构建不保证实时外站总可达。 |
| WebVoyager 原版镜像 / 浏览器 | lite 2af6926 | not_run | 只读预检确认缺匹配镜像；公开 GHCR 镜像源码/资产条件不同。固定 WebHarbor revision 所需 15 份公开资产齐全，压缩合计 2,680,985,142 bytes；尚未完整构建和运行 mirror，只有源码、规划与原评分器函数检查。 |
| 两套 Web ≥5 有效 empty / 模型正校准 | 原版 gpt-4.1 / o4-mini judge | not_run | 本轮按用户选择只做无需密钥的验证。原 judge key 缺失，不能把 judge_unavailable 当有效 0；真实计分校准留待可用评审配置。 |
| MobileWorld / OSWorld 注册与协议 | a026188 / d995367 + osworld-v2.1 | passed | 隔离 daemon add/tasks 保留 201 / 108 条任务；前提缺失时全部有具体 unsupported 原因。计划、保存评分和 GUI 格式通过共享契约。 |
| 原 SDK / OS 单任务函数 | docker 7.1.0 / d995367 | passed | Python 3.12 隔离检查：实际 ContainerCollection.run→create 配显式底层 API fixture；原版 reset→predict→step→evaluate→结果 logger 完整调用链配显式环境 fixture，60 秒等待替身。修复原版 args.result_dir 遗漏；不是 VM 运行。 |
| MobileWorld 完整原版依赖导入 | 轻量诊断客户端 | failed | 尝试导入因缺 loguru 拒绝；该客户端不是原版 frozen uv.lock 环境，没有据此开放任务或宣称完整依赖已准备。 |
| Mobile/OS ≥5 empty / 正例 / 故障 / 取消 | 原版 KVM 环境 | not_run | 缺 KVM、原版镜像/完整 Python 环境；OS 还需授权任务、固定资产和 VM archive。适配器明确拒绝，未改用模拟评分或软件仿真。 |
| Mobile/OS 开发检查清理 | 本次隔离检查 | passed | 六个开发 Run 全终态、cleanup done、lease released；orbit.run/orbit.parent 容器、网络、卷无残留，独立 daemon 已停止。 |
| 构建 / 拉取阶段自动取消 | 原 main 4184d4c | failed | 原 Docker starting/build/pull 取消未能中止准备；仅对核实归属的自有 CLI 温和终止后由 Orbit 回收。后续 process 构建正常取消成功；不能冒称原 starting 路径已修复。见 Next。 |
| 通用外部模型 Agent | 四个 hub | not_run | 已实现原生入口；本线真实正例为原版 oracle / 截图脚本，未验证通用模型。CLI Agent 的真实结果属 B 线。 |
| 全仓库检查 / rebase | main `4993f5f` / 本次复查 | passed | 已 rebase 最新本地 main；最终 pnpm verify：Orbit 434 / Web 51，格式、lint、类型、边界与构建通过。默认 opt-in 跳过项按上表独立真实或 fixture 结果记录。 |

## Next / open issues

- 本线代码已覆盖四个 hub；Mobile/OS 原版 KVM 验收与两套 Web 真正评分校准仍未完成，需要上述前提。没有把 fixture 或缺 key 的 invalid 计为成功验收。
- 准备完整 WebVoyager 原版资产镜像并做真实浏览器检查；两套 Web 均需补模型计分校准；其他未审查任务保持 unsupported。含 after 的 Web trial 暂不能 rescore，MiniWoB 应单独注册。
- Cua KiCad / workflows 的应用与账号条件未映射，继续 unsupported；原版 basic 其他变体未逐一校准。
- 主线核心取消缺口：将 AbortSignal 贯通 starting 阶段 Docker build/pull；当前显式 process 准备路径可正常取消，不能替代对默认准备路径的修复。本线未改核心。
