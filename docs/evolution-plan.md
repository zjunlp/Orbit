# Orbit 进化主线实施方案

更新 2026-11-12。本文是**实施计划**，用于逐项对照实现：统一轨迹、轨迹导出、复盘与分叉、进化门、参考进化器与跨环境实验。
架构与契约仍以 [design.md](design.md) 为准；每个工作包落地时，把最终设计写进 design.md 对应小节，并在本文勾选。
调研依据见 [research/trajectory/01-formats-export-fork.md](research/trajectory/01-formats-export-fork.md)。

使用方式：

- 一个工作包对应一个任务分支和一条 `docs/tasks/` 记录；验收项全部勾选、`pnpm verify` 通过并完成所列真实检查后才算完成。
- 标注 **〔先验证〕** 的条目依赖尚未在本机实测的外部行为，先做小验证再定方案。用户已确认的取舍记在 §10。
- 本文不记录个人实验结果、分数或批次进度（AGENTS.md §5）。

## 1. 目标与顺序

主线（design §1）：Agent 自己干活、自己改进自己，Orbit 让验收有据可依。要补的是三件事：

1. **证据可比**：不同 benchmark、不同 Agent 的轨迹是同一种形式，能导出、能逐步复盘、能从某一步分叉重跑。
2. **改动可判**：Agent 对自己的一次改动（一个带血缘的配置版本）由预先冻结的规则给出接受、拒绝或证据不足。
3. **结论可迁移**：同一个改动在别的 benchmark 族和别的 Agent 上是否成立，用迁移矩阵表达，不给总分。

| 编号 | 工作包 | 依赖 | 规模 | 状态 |
| --- | --- | --- | --- | --- |
| T1 | ATIF 契约与 Codex / Claude Code 转换器 | — | 中 | [x] |
| T2 | 轨迹生成、存储、API 与 CLI；会话视图改为从轨迹派生 | T1 | 中 | [x] |
| T3 | Token 记账 | T2 | 小 | [x] |
| T4 | 环境侧对齐（GUI、具身、对话） | T2 | 中 | [x] |
| T5 | 更多导入器（dsh、pi、Harbor / Cua ATIF 直通等） | T2 | 按需 | 原生 ATIF 已实现；其余按需 |
| T6 | Web 统一轨迹视图（逐步复盘） | T2、T3 | 中 | [ ] |
| X1 | 导出：ATIF 包与 Chat JSONL，含脱敏与筛选 | T2 | 中 | [x] |
| X2 | 导出：自包含 HTML | T6、X1 | 中 | [ ] |
| X3 | 导出：OTLP、LeRobot | X1 | 小 / 中 | [ ] |
| F0 | 分叉机制验证（Claude Code、Codex） | — | 小 | [ ] |
| F1 | 末态分叉：`orbit fork`，任意结束状态可留检查点 | F0、T2 | 中 | [ ] |
| F2 | 步级快照（可选开启） | F1 | 大 | [ ] |
| F3 | 步级分叉与 Web 入口 | F2、T6 | 中 | [ ] |
| F4 | 分叉结果的独立验收（反事实研究用） | F3 | 中 | [ ] |
| E1 | 任务集划分与冻结 | — | 小 | [x] |
| E2 | 判定核心（纯函数与统计） | E1 | 中 | [ ] |
| E3 | 策略文件、`orbit bench gate`、判定记录 | E2、T3 | 中 | [ ] |
| E4 | 分级流程助手与静态检查 | E3 | 小 | [ ] |
| E5 | Web：版本链上的判定与证据 | E3 | 中 | [ ] |
| E6 | 进化门校准 | E3 | 中 | [ ] |
| V0 | 试点：选族、测成本与翻转率 | T3、E1 | 中 | [ ] |
| V1 | 参考进化器 skill | X1、E3 | 中 | [ ] |
| V2 | 基线进化方法 | V1 | 中 | [ ] |
| V3 | 隔离运行的进化器（防泄漏加固） | V1 | 中 | [ ] |
| V4 | 跨环境准入实验 | V0–V2、E6 | 大 | [ ] |
| V5 | 迁移矩阵 | E3 | 中 | [ ] |
| S1 | 设计与文档同步 | 随各包 | 小 | [ ] |
| S2 | 对外演示：接入多 Agent 编排器的 Worker | V1 | 小 | [ ] |

里程碑（按先后，不绑定日期）：

- **M1 看得见**：T1–T3、X1。任意一次 Codex / Claude Code 运行得到一份通过校验的 ATIF 轨迹和 token 用量，可导出。
- **M2 判得了**：E1–E3、E6。对两个已有配置版本，按冻结策略给出三值判定，并通过 A/A 与破坏性校准。
- **M3 转得动**：V0–V2、E4、E5、T6。参考进化器在一个族上完成若干轮"改动 → 运行 → 判定"。
- **M4 讲得出**：V4、V5、X2。跨环境准入实验与迁移矩阵；轨迹和判定可以静态分享。
- **分叉线**与上面并行：F0 随时可做；F1 在 T2 之后；F2–F4 是成本最高、风险最大的部分，排在 M2 之后。

## 2. 实施前基线（T1 开始前，已对照代码）

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| Agent 会话 | 只解析 Codex、Claude Code；结果是扁平的 `SessionMessage`（文本被截断、无调用 id、无参数结构、无 token） | `sessions/index.ts`、`contracts/records.ts` |
| 原生会话文件 | 随 Run 保留在 `<run>/orbit/agent`（Agent home），可无损重读 | `config/paths.ts` `runDirs` |
| 环境侧轨迹 | 三种互不相同的复盘形状：`GuiTrajectory`、`EpisodeTrajectory`、`ConversationTrajectory`；导入器只有 EFE、RoboTwin、LIBERO | `contracts/bench.ts`、`contracts/trajectory.ts`、`bench/trajectory.ts` |
| 统一轨迹 | 只有设计（§9.8 的 `events.jsonl`），未实现 | — |
| Token 与成本 | 没有。`Run.usage` 只有内存 / CPU / 显存峰值 | `contracts/runs.ts` `RunUsage` |
| 导出 | `orbit export <folder> <dest>` 复制整个文件夹的 Run 与 job；没有轨迹格式导出；§9.9 的静态 HTML 未实现 | `cli/program.ts` |
| 检查点与续跑 | 可选开启、仅失败时；提交容器可写层、保存 `/orbit` 文件与 Agent home；`orbit resume` 新建带 `parentId` 的独立 Run，用 Agent 定义的 `resume` 模板续原会话。Codex 经真实模型验证，Claude Code 未验证。仅本地 Docker；不含服务容器、外部可写挂载、进程内存、GPU 状态；不进入 trial 分数 | `runs/checkpoint.ts`、[guides/checkpoints.md](guides/checkpoints.md) |
| 配置版本与血缘 | 内容修订号 `MethodRevision`；`lineage[method] = { parent?, note?, informedBy[] }`；`orbit bench run --parent --note --informed-by` | `bench/revision.ts`、`contracts/bench.ts`、`cli/bench.ts` |
| 配对统计 | `pairedDiff`（任务聚类标准误、95% 区间）、`verdict`（区间含 0 即"无法区分"）；版本对比优先取显式 parent | `contracts/metrics.ts`、`bench/hub.ts` |
| 报告 | 不可变的报告修订，`planDigest`，valid-only 均值 | `bench/summary.ts`、`store/` `bench_reports` |
| 任务选择 | 只有 `-t/--task`（可重复）；没有任务集文件、划分或冻结；`hub.ts` 已为结果计算 `taskSet` 摘要 | `cli/bench.ts`、`bench/hub.ts` |
| 进化门 | 不存在。§9.16 明确"不做方法进化声明" | — |

## 3. 关键决定

| 编号 | 决定 | 理由 |
| --- | --- | --- |
| D1 | Agent 侧**直接采用 ATIF**（Harbor 的 Agent Trajectory Interchange Format），不自造格式。写出 v1.7，读入 v1.5–v1.8；Orbit 的附加信息只放在 `extra.orbit` | ATIF 已覆盖步骤、工具调用与结果配对、思考、多模态、子 Agent、逐步 token 与成本；Harbor 的 Claude Code / Codex 适配器当前写 v1.7；规范拒绝未知顶层字段，扩展必须进 `extra` |
| D2 | **原生会话文件是真源**，ATIF 是可重建的派生物；转换器带版本号，升级后可重建 | 各家原生格式持续变化，任何统一格式都有损（加密思考、压缩状态、签名）；续跑和分叉必须回到原生文件 |
| D3 | 环境侧**不合并成一个大 schema**。`GuiTrajectory`、`EpisodeTrajectory`、`ConversationTrajectory` 保留，通过步骤上的引用与 ATIF 对齐；纯 Policy 评测没有 Agent 会话，只有 `EpisodeTrajectory` | 连续控制帧不适合塞进聊天消息；§9.8 已规定高频数据保留原格式。这一条替换 §9.8 原计划的 `events.jsonl` 封闭事件表，落地 T1 时改写 §9.8 |
| D4 | Token 记账**来自轨迹**，记在 Run 的独立字段 `tokens`，与资源峰值 `usage` 分开；默认只记 token，不按价格表折算金额 | 原生会话已带逐次调用用量；价格随时间和中转变化，折算留给使用者 |
| D5 | 分叉分三级：**会话级**（只有会话前缀）、**末态**（结束时的检查点）、**步级**（工具调用边界的快照）。界面只在确实可恢复的步骤上提供分叉，并写明等级 | 对话、文件、进程内存、外部世界四者不一致是最大的坑；不能承诺任意步精确恢复 |
| D6 | 分叉出的 Run **永不进入 trial 分数和报告** | 沿用 `orbit resume` 现有规则；分叉是干预，不是原评测的一部分 |
| D7 | 进化门是**只读判定**：输入父版本、子版本、冻结策略，输出判定和证据；不运行任务、不维护"当前最优" | 不引入第二个状态机；判定可由不可变报告重算 |
| D8 | 进化器在 **daemon 之外**，作为 skill 由用户的 Claude Code / Codex 执行；进化对象限于 bundle（文本与 skills），不改 Agent 源码 | "Agent 是本体"；Orbit 不提出改动 |
| D9 | 不做跨 benchmark 总分；跨环境结论用**迁移矩阵**逐格给出配对差与区间 | §9.14、§9.16 既有约束 |

## 4. T：统一轨迹

### 4.1 轨迹文件

每个带 Agent 会话的 Run 一份 `<run>/orbit/trajectory/trajectory.json`（ATIF）。trial 的轨迹就是其 solve Run 的轨迹。

`extra.orbit` 约定（契约在 `contracts/atif.ts`，随实现定稿）：

```jsonc
// 根 extra.orbit
{
  "version": 1,
  "run": "<run id>", "trial": "<trial id>", "job": "<job id>",        // 后两项仅 bench
  "benchmark": { "id": "…", "version": "…" }, "task": "…",
  "method": { "name": "…", "revision": "<12 hex>" },
  "importer": { "name": "codex-rollout | claude-jsonl | atif-passthrough", "version": 1 },
  "sources": [{ "path": "agent/codex/sessions/…jsonl", "sha256": "…", "bytes": 0 }],
  "completeness": "complete | truncated | agent-only | environment-only"
}
// 步骤 extra.orbit
{
  "native": { "id": "<原生消息 id 或 turn id>", "line": 123 },      // 分叉用的原生游标
  "reasoning": "raw | summary | opaque | none",
  "env": { "kind": "gui | episode | conversation", "ref": "<文件>#<序号>" },
  "checkpoint": { "id": "…", "level": "step | final" }
}
```

规则：

- token 归一化到 ATIF 口径（`prompt_tokens` 含缓存）。Claude Code 的 `input_tokens` 不含缓存，需加上
  `cache_read_input_tokens` 与 `cache_creation_input_tokens`；Codex 取 `last_token_usage`。原始值保留在 `metrics.extra`。
- 加密或签名的思考不进 `reasoning_content`，只标 `opaque`；原文留在原生文件里供续跑。
- 子 Agent（Claude Code 的 sidechain）写入 `subagent_trajectories`；主轨迹的统计不重复计入。
- 上下文压缩按 ATIF 约定写 `step.extra.context_management`。
- 图片等媒体按相对路径引用到 `trajectory/media/`，不内嵌 base64。
- 转换失败只给 Run 追加一条事件，不改执行结果、分数或有效性（沿用 §9.8 既有规则）。

### T1 ATIF 契约与两个转换器

分支 `feat/atif-trajectory`。模块：`contracts/atif.ts`（新）、`sessions/`（转换逻辑分在 `codex.ts`、`claude.ts`、`atif.ts`，
`index.ts` 保持公开入口与旧会话兼容；T2 再切换视图来源，保持 §3 依赖方向）。

- [x] `contracts/atif.ts`：ATIF 的 zod 定义（写 v1.7；读 v1.5–v1.8，未知版本报错而不是猜）与 `extra.orbit` 定义。
- [x] Codex rollout → ATIF：`response_item`（message、reasoning、function / custom tool call 与 output）、`token_count`、`compacted`。
- [x] Claude Code JSONL → ATIF：`uuid` / `parentUuid` 链、`tool_use` / `tool_result` 配对、`usage`、压缩摘要、sidechain。
- [x] 转换器是纯函数；每个带一组脱敏的真实样例作为 golden 测试（样例不含凭据、路径和任务答案）。
- [x] 开发检查：用 Harbor 的 `python -m harbor.utils.trajectory_validator` 校验产物（隔离的 Python 环境，不进 CI，不让 daemon 依赖 Python）。
- [x] 真实检查：本机各取一次真实的 Codex 与 Claude Code Run，转换后校验通过，工具调用与结果一一配对，token 合计与 CLI 自报一致。

风险：原生格式随 CLI 版本变化。对策：转换器记录见过的 `cli_version`，遇到未知事件类型时保留在 `extra` 并把完整度标为 `truncated`，不静默丢弃。

实现与验证见 [T1 任务记录](tasks/20261112-atif-trajectory.md)。

### T2 生成、存储、API、CLI

分支 `feat/run-trajectory`。模块：`runs/cleanup.ts`（收集 Agent home 之后生成）、`contracts/runs.ts`、`daemon/routes/runs.ts`、`client/`、`cli/`、Web 类型。

- [x] Run 结束阶段生成轨迹文件；`Run.trajectory = { schema, steps, completeness, importer } | null`。
- [x] `GET /runs/:id/trajectory`；`POST /runs/:id/trajectory/rebuild`（转换器升级后重建，旧文件按版本保留一份）。
- [x] `orbit trajectory show <run> [--json]`、`orbit trajectory rebuild <run…>`。
- [x] `GET /runs/:id/session` 改为从轨迹投影出 `SessionTranscript`，删除第二套解析路径；`runAgentFailure` 等调用点一并迁移。
- [x] 多节点：worker 生成，按现有产物读取路径经主节点访问。
- [x] 测试：老 Run（无轨迹文件）按需生成；无 Agent 的 Run 返回 `null` 而不是空轨迹。
- [x] 真实检查：一个真实 bench trial 结束后，CLI 与 Web 读到同一份轨迹。

实现与验证见 [T2 任务记录](tasks/20261113-run-trajectory.md)。真实 bench 检查覆盖失败终态的自动落盘、CLI/Web 一致性和重建，模型调用受已有认证/服务问题影响，未宣称成功解题。

### T3 Token 记账

按用户要求沿用分支 `feat/run-trajectory`。

- [x] `Run.tokens = { input, cachedInput, cacheWrite, output, reasoning, calls, costUsd?, source: "session" } | null`，由轨迹合计得到；`costUsd` 只在 CLI 自报时填写。
- [x] `orbit show`、`orbit bench usage`、报告条目与 Compare 页面显示 token；报告聚合只统计，不参与分数。
- [x] 中转或代理不返回用量时为 `null`，界面显示"未记录"，不补 0。
- [x] Codex 真实检查：同一小任务的会话汇总与 CLI 结束输出核对通过。
- [ ] Claude 成功用量核对：首次调用被服务端拒绝；用户要求停止进一步 Claude 检查。

实现与验证见 [T3 任务记录](tasks/20261113-token-accounting.md)。

### T4 环境侧对齐

按用户要求沿用分支 `feat/run-trajectory`。

- [x] GUI：`GuiTrajectory` 的每一步按动作 id 关联到发起它的工具调用步骤（现有 GUI 已按动作 id 关联）。
- [x] 具身（Agent 评测）：`EpisodeTrajectory.sessionStepIds` 引用轨迹 `step_id`，兼容旧 `sessionMessageIndexes`。
- [x] 对话（工具与模拟用户）：`ConversationTrajectory` 的 turn 关联到对应步骤。
- [x] 只有环境记录、没有会话时完整度为 `environment-only`；反之为 `agent-only`。
- [x] 测试覆盖已校准 MiniWoB click-test、EFE MetaWorld+、BFCL 的三类记录格式；使用可复现的协议样例，不宣称重新执行真实环境。

实现与验证见 [T4 任务记录](tasks/20261113-trajectory-environment.md)。

### T5 更多导入器

按"真的要跑这个 Agent 或 benchmark 时再做"的顺序，每个一个小分支：

- [x] Harbor / Cua 产出的 ATIF 直通：校验后采纳，补 `extra.orbit`。实现与验证见 [T5 第一包任务记录](tasks/20261113-native-atif-import.md)。
- [ ] dsh（会话格式 v4，带压缩帧，需用其自带的读取方式）、pi（`id` / `parentId` 树）。〔先验证〕两者的格式细节只在调研中读过文档。
- [ ] §9.8 原列表中的环境侧来源：MobileWorld、OSWorld、BrowserGym / AgentLab、vla-eval。

### T6 Web 统一轨迹视图

分支 `feat/web-trajectory-view`。替换 Run 详情里扁平的 Session 标签页。

- [ ] 步骤列表（虚拟滚动）：来源、消息、思考、工具调用与结果折叠、每步 token、耗时。
- [ ] 子 Agent 可展开；压缩边界有标记；并行工具调用成组显示。
- [ ] 右侧环境面板按 `env.kind` 复用现有 GUI / 具身 / 对话组件，随所选步骤同步。
- [ ] 有检查点的步骤显示标记（F2 之后可点分叉）。
- [ ] 键盘逐步前后移动；长轨迹（数千步）滚动流畅。

## 5. X：导出

命令组 `orbit trajectory export`（不复用现有的 `orbit export <folder>`，那是整目录复制）。导出由 daemon 执行，写到用户给的目录。

```bash
orbit trajectory export --job <job> --tasks-file evolve.txt --format atif --out /path/out
orbit trajectory export --run <id> --format chat-jsonl --reasoning none --out /path/out
```

### X1 ATIF 包与 Chat JSONL

已实现于 `feat/run-trajectory`（[设计 §9.8](design.md#98-统一轨迹)、[使用指南](guides/trajectory-export.md)）。模块：`sessions/export/`（纯转换）、`bench/`（按 job / trial 选取）、daemon 路由、client、CLI。

- [x] 选择器：`--run`、`--trial`、`--job`，可加 `--tasks-file`、`--method`、`--valid-only`、`--outcome pass|fail`。
- [x] `atif`：每条轨迹一个目录（`trajectory.json` 与 `media/`），外加 `manifest.json`：任务、配置修订号、执行结果、评分有效性、分数、
  token、各文件 SHA-256、所用筛选条件、导出器版本。执行结果与有效性分开写。
- [x] `chat-jsonl`：每行一条 `messages`（含 `tools` 与工具调用），供监督微调使用；加密思考一律不导出。
- [x] 脱敏：复用现有 redactor，再对导出内容做一遍密钥模式扫描；命中即失败并指出位置，不静默替换后继续。
- [x] `--reasoning raw|summary|none`，默认 `summary`。
- [x] `manifest.json` 带一段固定说明：轨迹可能包含上游 benchmark 内容与模型生成内容，再分发前需自行核对许可。
- [x] 测试：导出再读回，步骤数与工具配对不变；含密钥的夹具导出失败。

### X2 自包含 HTML

- [ ] 一个 trial 或一个 job 导出为单个可离线打开的 HTML（§9.9 已计划），复用 T6 的组件做只读渲染。
- [ ] 大媒体按需外置，文件体积有上限并在超限时提示。

### X3 OTLP 与 LeRobot

- [ ] OTLP JSON：按 Harbor `atif2otel` 的映射。OpenTelemetry GenAI 语义约定仍是 Development 状态，标为实验性，不作为恢复来源。
- [ ] LeRobotDataset：从 `EpisodeTrajectory` 导出（§9.8 已计划），需要独立的 Python 环境，放在 `examples/` 的脚本里，不进 daemon。

## 6. F：复盘与分叉

"复盘"由 T6 提供（逐步查看）。本节是"从某一步开始重跑"。

### 6.1 已知事实

| 项 | 事实 | 来源 |
| --- | --- | --- |
| Claude Code 2.1.319 | `--resume`、`--fork-session`；另有未在帮助里列出的 `--resume-session-at <message id>`（只保留到该条消息，配合 `--resume` 在 print 模式使用）与 `--rewind-files` | 本机二进制 |
| codex-cli 0.167.0 | `codex exec resume`、`codex exec fork <session> <prompt>`（整段分叉，没有截断参数）；app-server 的 `thread/fork` 有 `lastTurnId`（含该 turn，不能是进行中的 turn） | 本机 CLI 与生成的协议 schema |
| 无头评测的形态 | 一次求解通常只有一个用户 turn，Codex 的按 turn 分叉切不到中间的工具调用 | 推断 |
| Harbor | 把 ATIF 转回原生会话文件放进 Agent home，再用 `claude --resume` / `codex exec resume` 接上；文档写明有损，且不恢复沙箱文件 | Harbor 源码与文档 |
| Hooks | Claude Code 有 `PostToolUse`；Codex 的 `hooks` 特性为 stable | 本机 CLI |
| `docker commit` | 只含容器可写层，不含挂载卷；每次提交都是完整的可写层差异，不是相邻两次之间的增量 | Docker 文档 |
| Orbit 工作区 | `/workspace` 与 `/orbit` 是宿主机挂载目录，不在容器可写层里 | `runs/launch.ts` |

### F0 分叉机制验证〔先验证〕

不改产品代码，产出一份 `docs/research/trajectory/` 记录和 §6 的定稿。

- [ ] Claude Code：容器内 `claude -p --resume <id> --resume-session-at <uuid> --fork-session "<新指令>"` 是否得到一个只含前缀的新会话；
      该参数未公开，记录所测版本，并准备备选（复制会话文件并截到该链条目）。
- [ ] Codex：三种做法各试一次并比较。(a) 复制 rollout 文件，在一次完整的"工具调用 + 结果"之后截断并改写会话 id，再 `codex exec resume`；
      (b) 由 ATIF 前缀生成 rollout（Harbor 的做法）；(c) 通过 app-server 分叉。记录哪种能续跑、丢了什么（加密思考、压缩状态）。
- [ ] 两家各确认：续跑时模型是否把前缀当作自己的历史继续，而不是从头重做。
- [ ] 结论写入 Agent 定义的新字段设计：`fork` 模板与能力 `fork: none | whole | prefix`。

### F1 末态分叉

分支 `feat/run-fork`。在现有检查点上扩展，不新增执行路径。

- [ ] 检查点策略增加时机：`--checkpoint-on failure|always`（默认仍为 `failure`）。
- [ ] `orbit fork <run> [--prompt <text>] [--bundle DIR] [--model M] [-w]`：恢复末态，用**新指令**在新会话 id 上继续；
      `orbit resume` 保持原语义（同一指令续跑）。
- [ ] `Run.forkedFrom = { run, step: null, level: "final", changes: { prompt?, bundle?, model? } }`；改了 bundle 或模型时记录差异，标明这是一次新干预。
- [ ] 分叉 Run 不属于任何 trial，不进入报告（D6）；源检查点在分叉 Run 排队或运行期间不可删除（现有规则）。
- [ ] 真实检查：Codex 与 Claude Code 各一次，从一个已结束的 Run 分叉、换指令继续并完成。同时补上 Claude Code 续跑的真实验证（现状缺口）。

### F2 步级快照（可选开启）

分支 `feat/step-snapshots`。这是整条线里成本和风险最高的一包，默认关闭。

- [ ] 策略：`--snapshots every=<k>,max=<GiB>`（每 k 次工具调用一个快照，总量封顶；超限后停止快照并记事件，不影响求解）。
- [ ] 一致性：Orbit 在 Agent home 写入 `PostToolUse` hook。hook 向 `/orbit` 下的请求文件写入当前调用 id 并等待应答；
      daemon 监视到请求后做快照、写应答，hook 返回。全程不需要容器网络。没有 hook 的 Agent 不支持步级快照。
- [ ] 快照内容：容器可写层（`docker commit`）、工作区（相对上一个快照的硬链接增量复制）、Agent home、当时的原生会话游标；
      清单写入 `trajectory/checkpoints.json`，对应步骤写 `extra.orbit.checkpoint`。凭据按现有检查点规则剥离。
- [ ] 评测条件：开启快照会增加耗时并改动 Agent 配置，因此记入比较条件（`comparisonCondition`），不与未开启的结果混比。
- [ ] 清理：快照镜像带 Orbit 标签，随 Run 删除；`orbit reconcile` 能回收孤儿快照。
- [ ] 真实检查：一个真实 trial 开启快照，核对快照数、占用空间、求解耗时增量；删除 Run 后镜像与目录都被清理。

不做：进程内存与 GPU 状态（CRIU 类热恢复）、服务容器、外部可写挂载、远程节点。训练类任务靠程序自己的 checkpoint。

### F3 步级分叉与 Web 入口

分支 `feat/fork-from-step`。

- [ ] `orbit fork <run> --step <n> [--prompt …]`：取不晚于第 n 步的最近快照，按 F0 选定的机制截取会话前缀；
      实际使用的步骤与请求不同时在输出和记录里写明。`forkedFrom.level = "step"`。
- [ ] 没有快照时可显式 `--conversation-only`：全新任务环境加会话前缀，`level = "conversation"`，界面注明环境状态与会话不一致。
- [ ] Web：轨迹视图里只有可恢复的步骤显示"从这里分叉"，弹出可编辑的指令与等价的 CLI 命令；Run 详情显示分叉来源与子分叉列表。
- [ ] 真实检查：同一 trial 从中间一步分叉两次（原指令与改动后的指令），两个分叉 Run 都从该步的文件状态开始。

### F4 分叉结果的独立验收

- [ ] `orbit fork … --verify`：分叉 Run 结束后，用原 trial 的 verifier 对其产物做一次独立评测，结果记在分叉 Run 上，
      在原 trial 的"分叉"列表里可见，**不写入 job 报告**。
- [ ] 用途：失败归因与反事实研究（改动某一步之后是否成功）。恢复不保证与原执行等价，结果需标注恢复等级。

## 7. E：进化门

### 7.1 语义

进化门回答一个问题：**子版本相对父版本，是否值得接受**。输入是两个配置修订号和一份预先冻结的策略；
所用数据只来自不可变的报告修订。输出三值判定和证据清单。

四类任务集（都是任务 id 列表文件，按内容摘要冻结）：

| 任务集 | 用途 | 进化器能看什么 |
| --- | --- | --- |
| 进化集 | 进化器阅读失败轨迹、做改动 | 轨迹和分数都可看；这里的分数不算证据 |
| 准入集 | 同族、未见过；判断"是否变强" | 只能看到判定结果 |
| 守护集 | 其他族，以及本族过去已通过的任务；判断"是否退步" | 只能看到判定结果 |
| 终测集 | 含第二种 Agent；多轮接受之后才跑，不参与准入 | 不可见 |

子版本及其所有祖先的 `informedBy` 引用过的任务，自动从准入集和守护集中剔除后再计算。

三项检查，全部通过才接受：

1. **提升**：准入集上配对差的单侧置信下界 > 0。
2. **不退步**：每个守护集上配对差的单侧置信下界 > −δ（δ 为预设边界）。达不到是"证据不足"，不是"拒绝"；
   下界与上界都在 −δ 以下才是"拒绝"。这与现有 `verdict()`（区间含 0 即无法区分）不同，需要新函数。
3. **成本**：墙钟时间与 token 的比值不超过上限。

三项同时成立才接受，属于交并检验，同一轮内各项不需要再做多重校正；**多轮之间**用 α 消耗：第 k 轮用 `α·6/(π²k²)`。
轮次 k 由已存作业推导（同一准入集摘要上、同一血缘链里更早被评测过的子版本数加一），不另存账本。

判定为 `accept | reject | insufficient`；接受时附等级：**本域有效**（只过准入集）、**跨域稳健**（守护集全过）、
**可迁移**（终测集上第二种 Agent 也成立）。"可迁移"只是等级与矩阵里的一列，不作为准入条件。

前提检查（不满足直接给 `insufficient` 并说明原因）：

- 父子版本除 bundle 摘要外的基础项（Agent、模型、思考强度、CLI 版本、benchmark 版本与条件）一致；否则父结果过期，需要重跑父版本。
- 配对任务数不少于 `min_paired_tasks`；两个版本都有效的任务占任务集的比例不低于 `min_coverage`；子版本的无效率没有明显高于父版本。
- 策略文件里各任务集的摘要与实际作业的任务集一致。

### 7.2 样本量（先看这个再定 δ）

近似公式（正态近似、任务相互独立）：记翻转率 `p_d` 为父子结果不同的任务比例，真实差为 Δ，则配对差的标准差约为
`sqrt(p_d − Δ²)`，所需配对任务数约为 `((z_α + z_β) · sqrt(p_d − Δ²) / Δ)²`。不退步检验在真实差为 0 时把分母换成 δ。

| 目的 | 设定 | 第 1 轮（α₁ ≈ 0.030）、80% 功效所需配对任务数 |
| --- | --- | --- |
| 确认 5 分提升 | 翻转率 10% | 约 290 |
| 确认 5 分提升 | 翻转率 20% | 约 580 |
| 确认 10 分提升 | 翻转率 20% | 约 140 |
| 证明退步不超过 2 分 | 翻转率 10% | 约 1840 |
| 证明退步不超过 5 分 | 翻转率 10% | 约 300 |
| 证明退步不超过 10 分 | 翻转率 10% | 约 75 |

两点结论：

- 此前口头估计的"150–300 个配对任务确认 5 分提升"只对应约 50% 的功效；按 80% 功效是 290–580。
- **δ = 2 分在几百个任务的守护集上不可行**。默认 δ = 5 分、α = 0.05，守护集按 300 个任务左右准备；任务不足的族只能给"证据不足"。

实际翻转率和单任务成本由 V0 试点测得，再回来修订本表。

### E1 任务集划分与冻结

已实现于 `feat/run-trajectory`，见 [任务集指南](guides/task-sets.md) 和 design §7。

- [x] `orbit bench split <benchmark> --evolve <p> --gate <p> --final <p> --seed <n> [--stratify suite] --out DIR`：
      写出各任务集文件与 `split.json`（benchmark 身份与版本、随机种子、每个文件的 SHA-256）。划分确定、可复现。
- [x] `orbit bench run --tasks-file <file>`，与 `-t` 互斥；作业记录任务集摘要（`hub.ts` 已有 `taskSet`，改为随作业保存）。
- [x] 任务集文件归用户所有，daemon 不保存"任务集"实体。
- [x] 测试：同一种子两次划分结果相同；各集合互不相交；任务文件与作业摘要不一致时拒绝。

### E2 判定核心

分支 `feat/gate-core`。模块：`contracts/gate.ts`（`GatePolicy`、`GateVerdict`）、`contracts/metrics.ts`（新增统计函数，Web 可复用）、`bench/gate.ts`（纯函数）。

- [ ] `lowerBound(diff, alpha)`、`nonInferior(diff, margin, alpha)`、`alphaAt(round, alpha)`；二值指标另给精确 McNemar 的 p 值作对照。
- [ ] `gate(parent, child, policy, reports) → GateVerdict`：
      `{ decision, level, checks[], regressions[]（父通过而子失败的任务）, alpha: { round, level }, inputs: { parent, child, reports[{ job, revision }], policyDigest, taskSets } }`。
- [ ] `informedBy` 闭包剔除；前提检查逐条给出原因。
- [ ] 模拟测试：在合成的配对结果上重复抽样，无差异时接受率不超过 α；已知提升下的功效与 §7.2 的估计同量级；多轮接受率受 α 消耗控制。
- [ ] 不读文件、不访问 daemon 状态，便于在 Web 和测试里复用。

### E3 策略文件、CLI 与判定记录

分支 `feat/bench-gate`。

策略文件（YAML，仓库已有 `yaml` 依赖）：

```yaml
version: 1
alpha: 0.05
spending: inverse-square
min_paired_tasks: 30
min_coverage: 0.9
change: bundle-only            # 父子版本只允许 bundle 不同
gate:
  benchmark: <benchmark id>
  tasks: { file: gate.txt, sha256: … }
guard:
  - { benchmark: <id>, tasks: { file: guard-a.txt, sha256: … }, margin: 5 }
  - { benchmark: <id>, tasks: { file: guard-b.txt, sha256: … }, margin: 5 }
final:
  - { benchmark: <id>, tasks: { file: final.txt, sha256: … }, agents: [codex, claude-code] }
cost: { max_wall_ratio: 1.5, max_token_ratio: 1.5 }
```

- [ ] `orbit bench gate --policy gate.yaml --parent <rev> --child <rev> [--json]`；退出码区分三种判定。
- [ ] `POST /bench/gates`（计算并保存）、`GET /bench/gates?child=<rev>`。判定记录不可变，内含策略全文与摘要、所用报告修订；
      与报告修订同样存为文档，不是状态机。数据变化后重新判定产生新记录，旧记录保留。
- [ ] 成本检查读取 T3 的 token；缺失时该项为"未检查"，不当作通过。
- [ ] 真实检查：对两组已有的真实作业跑通一次完整判定。

### E4 分级流程助手与静态检查

- [ ] `orbit bench gate plan --policy … --parent … --child …`：列出还缺哪些"任务集 × 版本"的结果，并打印对应的 `orbit bench run` 命令。门本身不提交任务。
- [ ] `orbit bench gate check-bundle <dir> --policy …`：bundle 大小上限、密钥扫描、是否出现准入集 / 守护集的任务 id 或参考答案文件摘要。
- [ ] 建议的省钱顺序写进 skill：静态检查 → 进化集冒烟 → 准入集 → 守护集（按六维分类分层抽样）→ 多轮接受后才跑终测集与第二种 Agent。

### E5 Web

- [ ] Configurations 页面的版本链上显示判定徽章；点开看三项检查、区间、轮次与所用 α、退步任务列表（可跳到两个 trial 的轨迹并排对比）。
- [ ] "证据不足"与"拒绝"用不同样式，并写明缺什么。

### E6 校准

- [ ] A/A：同一 bundle 当作父与子，各自独立运行；判定不应为接受。真实跑一次，另用已有逐任务结果做重抽样估计接受率。
- [ ] 破坏性：故意损坏的 bundle（例如指示 Agent 直接放弃）必须被拒绝。
- [ ] 过期父结果：更换 CLI 版本后用旧的父结果，必须得到"需要重跑父版本"。
- [ ] 泄漏：`informedBy` 引用了准入集任务时，该任务被剔除并在证据里列出。
- [ ] 校准记录只写结论与方法，不写个人实验分数。

### 7.3 对 design 的修改（随 E3 提交）

- §9.16 的"不做：独立 Method 系统或方法进化声明"改为"不做独立 Method 系统；对配置版本给出准入判定（进化门）"，并新增一小节写入本章定稿。
- §1 删去"进化门仍在设计中"的说明；§5 增加 `/bench/gates`。

## 8. V：进化器与实验

### V0 试点

- [ ] 选一个目标族和两个守护族。条件：任务数够（见 §7.2）、真实 Agent 运行已通、单任务成本可承受、分属不同的六维分类。
      候选需先用 `orbit bench tasks` 确认可用任务数；MiniWoB++（125 个任务）可作 GUI 守护族的起点，但数量只够较大的 δ。
- [ ] 每族取一个小样本，同一配置重复运行，测出翻转率、无效率、单任务 token 与耗时；据此修订 §7.2 并确定各任务集规模。
- [ ] 用 E1 划分并冻结任务集，写出第一份策略文件。

### V1 参考进化器

`plugin/skills/orbit-evolve/SKILL.md`。由用户的 Claude Code 或 Codex 执行，Orbit 不启动它。一轮的步骤：

1. 确定父版本及其 bundle 目录；
2. `orbit trajectory export --job … --tasks-file evolve.txt --outcome fail` 取进化集的失败轨迹；
3. 阅读轨迹、归纳失败原因，在 bundle 的副本上修改（AGENTS.md / CLAUDE.md 与 skills）；
4. `orbit bench gate check-bundle`，进化集冒烟；
5. `orbit bench gate plan` 给出要跑的作业，带 `--parent --note --informed-by` 提交；
6. `orbit bench gate`；接受则以子版本为新的父版本，拒绝或证据不足则记录原因后再试；
7. 遵守预算：每轮最多改动量、最多轮数、总 token 上限。

- [ ] skill 文本与一个最小示例 bundle；随 `orbit plugin install` 分发。
- [ ] 真实检查：在试点族上跑完至少一轮，产生一条带血缘的子版本和一条判定记录。

### V2 基线

每个基线都只需要产出一个 bundle，因此都以 skill 变体实现，共用 V1 的提交与判定步骤。

- [ ] **不改动**（A/A）：衡量噪声。
- [ ] **有界笔记**：只允许从失败中向 AGENTS.md 追加不超过固定行数的笔记。这是必做的最简基线。
- [ ] **一到两个已发表的方法**作为被试（例如"演化式手册"一类与"搜索 harness 配置"一类）。V2 开工时按当时可复现的实现选定。

### V3 隔离运行的进化器

`informedBy` 是自报的。加固做法：把"阅读轨迹并产出 bundle"这一步作为一个 Orbit Run 执行，只读挂载进化集的轨迹导出，
产物是 bundle 目录；提交作业与判定仍在外层。这样进化器物理上读不到准入集和守护集的轨迹。

- [ ] 外层脚本与说明；真实检查一次。

### V4 跨环境准入实验

假设：只在本族内贪心接受的进化，比加上跨环境守护的进化，更容易在其他族退步、更难迁移到另一种 Agent。

- [ ] 同一进化器、同一目标族、同样的轮数与预算，两种准入规则各跑若干条独立的链：(a) 只看准入集；(b) 准入集加守护集。
- [ ] 结束后在**从未用于准入**的终测集上比较：2–3 个留出族，以及第二种 Agent。
- [ ] 报告每个格子的配对差与区间、被拒绝的轮数、总成本；不合成总分。
- [ ] 结果与过程记录放在用户侧，不进仓库；仓库只收可复现的脚本与方法说明。

### V5 迁移矩阵

不新增实体。一个格子由（父 bundle 摘要，子 bundle 摘要，Agent 与模型，benchmark）确定，值是该条件下子相对父的配对差、区间与判定。

- [ ] `orbit bench transfer --parent-bundle <digest> --child-bundle <digest> [--json]` 与 `GET /bench/transfer`。
- [ ] Web：行是进化出的改动，列是"benchmark 族 × Agent"，格子显示配对差与区间；没有数据的格子留空，不补 0，不给行列合计。
- [ ] 测试：条件不一致（benchmark 版本、资源条件）的结果不进入同一格。

## 9. S：支撑事项

### S1 设计与文档同步

- [ ] T1 落地：改写 design §9.8（D1–D3），§4 增加 `Run.trajectory`、`Run.tokens`，§5 增加轨迹与导出路由。
- [ ] F1–F3 落地：design §4 增加 `forkedFrom` 与快照策略；更新 [guides/checkpoints.md](guides/checkpoints.md)，新增分叉指南。
- [ ] E3 落地：§7.3 所列修改；新增进化门指南。
- [ ] 每包完成后更新 [status.md](status.md) 与 README 路线表中"进化门与统一轨迹"一行的状态；指南只写已实现的行为。

### S2 对外演示

- [ ] 多 Agent 编排器（规划 Agent 分派多个 Worker）里的一个 Worker 通过 `orbit` skill 提交实验、读取判定；
      演示脚本放 `examples/`，展示"Worker 自述完成"与"Orbit 独立验收"的差别。只做演示，不引入编排逻辑。

### S3 不做

- daemon 内的进化循环、规划 Agent 或研究编排；自动把子版本设为"当前最优"。
- 跨 benchmark 总分或总榜。
- 进程内存 / GPU 状态的热快照；任意步精确恢复的承诺。
- 把 OTLP 或任何有损导出当作恢复来源。
- 自造 Agent 侧轨迹格式。

## 10. 已确认的取舍与风险

已确认（2026-11-12）：

1. 守护边界 δ 默认 5 分（2 分按 §7.2 不可行），α 默认 0.05；策略文件可以按族覆盖。
2. "可迁移"不作为准入条件，只作为等级和矩阵的一列。
3. 步级快照（F2–F4）排在进化门（M2）之后。它工作量最大，而主线实验（V4）不依赖它。
4. 被试方法（V2 第三项）在 V2 开工时选定，选当时能复现的一到两个。

主要风险：

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 原生会话格式与隐藏参数随 CLI 版本变化 | 转换或分叉悄悄失效 | 转换器按 CLI 版本记录；未知事件保留并降级完整度；F0 的结论绑定所测版本，升级后重测 |
| 任务数不够 | 大多数判定是"证据不足" | V0 先测翻转率；守护族优先选任务多的；同一任务多种子以降低任务内噪声 |
| 运行成本 | 每轮要在准入集和守护集上跑父与子 | E4 的分级顺序；父结果在条件不变时复用；守护集分层抽样 |
| 无效 trial 掩盖失败 | 配对只用双方有效的任务，可能偏向子版本 | 覆盖率与无效率前提检查 |
| 步级快照的空间与耗时 | 每次提交都是完整可写层 | 默认关闭、总量封顶、按间隔取样；盘空间不足时停止快照而不是让 Run 失败 |
| 分叉后的执行与原执行不等价 | 反事实结论不可靠 | 记录恢复等级；F4 的结果不进报告，结论里注明等级 |
| 导出泄露密钥或受限内容 | 合规问题 | 导出前扫描并失败；清单记录筛选条件与许可提示；加密思考不导出 |
