# P6 + P5-Web：CLI Agent 的 GUI 桥与场景化 Trial 视图（并行线 B）
branch: feat/p6-cli-agent-bridge · status: completed · updated: 2026-11-04 · owner: Codex（主线由 Claude 负责）

本文是交给实现者的任务书，完成后在同一文件补写 Changes / Validation，作为该 Part 的记录。
动手前按 [AGENTS.md](../../AGENTS.md) §1 阅读 design.md（§6 Agent 注册表、§7、§9.4–§9.9）、status.md、
[guides/gui-bench-web.md](../guides/gui-bench-web.md)、[examples/bench-adapters/browsergym/](../../examples/bench-adapters/browsergym/)
与 [research/gui-bench/06-cua-lite.md](../research/gui-bench/06-cua-lite.md)（动作约定与非幂等 step）。

## Goal

1. **CLI Agent 操作 GUI（P6）**：让任意已注册的 CLI Agent（Claude Code、Codex、pi、dsh…）通过容器内工具操作 GUI 环境，
   首个落地环境是现有 BrowserGym / MiniWoB（125 任务）。目前 BrowserGym 只支持 `external` 策略与 `empty`。
2. **场景化 Trial 视图（P5 的 Web 部分）**：GUI 轨迹回放增强，以及具身 episode 的时间轴视图（为主线 P4/P5 的具身接入准备）。

## 设计（按此实现；有更好方案先写进本文再改）

### 1. 环境服务与工具

```
solve Run
  main 容器：CLI Agent + orbit-computer 工具（CLI 与 MCP stdio 两种入口）
      │ HTTP，Run 私有网络，服务名 gui
  service `gui`：BrowserGym 环境服务（同一镜像 orbit-browsergym，新入口 server.py）
      reset → observe → act → finish；原版 reward 与终止由 env.step 产生，轨迹由服务端记录
```

- **服务端**（`examples/bench-adapters/browsergym/server.py`）：持有唯一一个 episode；接口
  `GET /spec`（动作集合、截图尺寸、步数上限）、`GET /observe`（截图 PNG 路径或 base64、goal、上一步错误；
  `bid` 条件下含 a11y 树）、`POST /act {action, id}`、`POST /finish`、`GET /status`。
  `act` 带调用方生成的 `id`：**同一 id 重复提交返回第一次的结果，不重复执行**（非幂等 step，design §9.5）。
  步数用尽、终止或 finish 后拒绝新动作。轨迹、截图、`result.json`、哈希与现有 `runtime.py` 输出**格式相同**，
  以便现有 `evidence.py` verify 与 Trial 回放不改动即可使用；尽量与 runtime.py 共享代码而不是复制。
- **动作约定**：沿用 BrowserGym 原版高层动作字符串（`click(x, y)`、`fill(bid, text)`…），由 `/spec` 给出
  `action_description`；不要自造动作语言，以免改变评测条件。观测权限（是否给 a11y 树）随 `actionSet` 固定并写入 conditions。
- **工具**（`examples/tools/orbit-computer/`）：单文件 Python（BrowserGym 镜像有 Python；其他镜像以后再说），
  子命令 `spec | observe | act '<action>' | finish`，以及 `mcp` 子命令启动 MCP stdio server，暴露同样四个工具。
  截图以文件路径返回（Agent CLI 能读图片的读路径）。工具不持有密钥，只连 `ORBIT_GUI_URL`。
- **适配器**：`capabilities.methods` 增加 `cli`（design §7：显式允许所有 CLI Agent）。`cli` 方法的 solve spec：
  `agentTask` = 原任务 goal + 工具用法说明（固定模板，写入 conditions，不含答案）；main 镜像用 BrowserGym 镜像，
  挂载工具；service `gui` 运行 server.py。Agent 需要模型网络，`gui` 服务只在私有网络上。
  MCP 配置：Claude Code / Codex 能读 MCP 配置时写入其 Agent home（参考各 Agent 的 `auth.home`），不能时只用 CLI。
- **结束顺序**（design §9.6 第 7 条）：Agent 退出后先 `finish`（若未调用），再采集服务端证据；评分只读服务端记录。

### 2. Web 视图（`packages/web`）

- GUI 回放（现有 trajectory 查看器）：在截图上叠加动作位置（坐标点/拖拽线）、输入文本、动作错误；
  与 Run 内 Agent 会话并排（同一 step 的 thinking/tool_call）。
- 具身 episode 视图：新的 review kind（如 `episode`），输入是一个 JSON 索引：多路相机帧或视频 + 时间戳、
  动作与本体状态数组（关节曲线，uPlot）、action chunk 边界、reward、terminated/truncated、实时模式的 late/stall 标记。
  先用测试 fixture 驱动；主线后续让 vla-eval / EFE 适配器产出该格式。
- 新 schema 放新文件 `packages/orbit/src/contracts/trajectory.ts`（从 `contracts/index.ts` 导出）；
  `contracts/bench.ts` 只允许改 `REVIEW_KINDS` 一行；同步 `packages/web/src/lib/review.ts`。

## 边界（必须遵守）

- **可改**：`examples/bench-adapters/browsergym/**`、`examples/tools/**`、`packages/web/**`、
  `packages/orbit/src/contracts/trajectory.ts`（新）、`contracts/index.ts`（导出一行）、`contracts/bench.ts` 的 `REVIEW_KINDS`、
  `packages/orbit/src/harness/definitions.ts` 中各 Agent 的 `capabilities.gui`（仅在真实验证通过的 Agent 上设为 true）、
  `docs/guides/gui-bench-web.md`、本任务记录、`docs/status.md` 相关行、相关测试。
- **不改**（主线正在改）：`packages/orbit/src/{resources,runs,cluster,executor,bench}/**`、`contracts/{runs,resources}.ts`、
  `bench/compose.ts`、`bench/harbor.ts`、`examples/bench-adapters/` 下除 browsergym 外的目录（归并行线 A）。
  需要核心能力（例如服务容器的新字段）时不要自己改，写进 Next，由主线实现。
- 不新增状态机、队列或数据库；daemon 仍是唯一写者。

## 验收

| 检查 | 要求 |
| --- | --- |
| `pnpm verify` | 通过；BrowserGym `unittest` 通过（含服务端幂等 act、步数用尽、finish 后拒绝、证据格式与 runtime 一致） |
| 回归 | 现有 `external` / `empty` 路径结果不变（MiniWoB empty 抽样仍为 valid 0） |
| 真实 CLI Agent | 隔离 daemon 中至少一个真实 CLI Agent（本机可用：claude-code、codex、dsh、kimi）用 `cli` 方法在 ≥5 个 MiniWoB 任务上跑通，得分来自原版 reward，轨迹可在 Web 回放；记录成功率但不作为验收门槛 |
| 证据隔离 | Agent 不能直接写服务端证据；重复 act id 不重复执行；未调用 finish 时由结束流程补上 |
| Web | GUI 叠加与具身视图有组件测试；在浏览器中打开检查一次（截图或说明），没看就记 not_run |
| 记录 | 本文 Validation 表逐项写 passed / failed / not_run（附原因）；guide 更新使用方法 |

## 交付

- 拆成小提交（服务端与工具 / 适配器 cli 路径 / Web 视图），提交信息不加任何 AI 署名行。
- 完成后：rebase 到最新 main，`pnpm verify` 通过，通知用户；**合并由主线负责**，不要直接推送 main。
- 本文的 Changes / Validation / Next 补齐后状态改为 completed。

## Implementation decisions

- 原版 goal 随 reset/seed 动态产生；固定 agentTask 模板要求先 spec/observe，直接使用服务返回的 goal，不在规划时猜测。
- CLI 证据增加 Ed25519 签名：Agent 能预建自身 output 中未来的 service collect 目标，现有 docker cp 可能把真实目录复制到其子目录，单纯文件哈希无法证明来源。每 trial 在仅 gui 可见的 staging 中以 0600 生成临时私钥，不放入 plan、环境、日志或产物；公钥以单行 DER/base64 保存在 daemon 记录的 gui service env。服务签署包含既有 sha256 manifest 的 result.json，独立保存签名。CLI verify/score 只信 solve.run 中的公钥，缺失/无效签名为 invalid；external/empty 保持原格式兼容。重查不依赖已删除的私钥/staging。
- 当前文件 API 无视频 MIME/Range，Web 以可中止的流读取为每个 episode 合计提供 64 MiB 的视频预览预算，按视频相机均分；超限与不支持的媒体明确提供下载。大视频流式支持由主线后续补齐。

## Changes

- `651ee5a`：抽出共享 Episode；新增单线程 GUI HTTP 服务与幂等 act、CLI/MCP 工具、Run 专用 MCP 配置。保持 external/empty 的原版 reward、停止优先级和 policy→environment 清理顺序；固定 Playwright 1.44.0、MCP 1.6.0、Pydantic 2.10.6。
- `32d5135`：BrowserGym 声明 cli；main 只读挂载工具，私有 gui 持有任务/证据，hook 与 SIGTERM 负责 finish；CLI 证据签名、公钥重查与失败分类。只将真实验证通过的 Claude Code 标为 gui；保留其他 Agent 原能力值。
- `fb4645f7`：GUI 坐标/拖拽、文本与错误叠加，按动作 id 精确关联会话；新增 episode 契约、双端校验、多相机/视频时间轴、uPlot 动作/本体曲线、chunk 与 late/stall。具身格式使用明确 fixture，不声称实际具身 adapter 已接入。
- 更新使用指南与独立 opt-in Docker/真实 CLI 验收；未修改禁改核心目录，未引入上游队列或数据库。
- 复查修正 GUI 会话对齐：返回结果必须同时匹配动作 id 与 step，连续工具结果不再带入上一个无关结果；新增精确关联与 MCP 嵌套结果回归。

## Validation

提交号引用 rebase 后的等价实现；首次验证基线与新主线复查分别注明。

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| 首次交付 / `pnpm verify` | `fb4645f7` + 本记录 | passed | 首次交付基线为本地 main `4184d4c`；格式/lint/types/boundaries、Orbit 422 项、Web 60 项与构建通过。默认跳过的 opt-in 真实检查按下列独立结果记录。 |
| BrowserGym Python 单测 | `32d5135` | passed | 宿主 29 项中 28 通过；Python 3.10 不含 tomllib 的入口测试显式跳过。真实 Python 3.11 镜像内 29/29 通过；fixture 测试不代替真实浏览器。覆盖重复 id、耗尽/finish、停止优先级、清理顺序、签名/篡改/错误阶段。 |
| external / empty 真实回归 | `browsergym.docker.test.ts` | passed | 隔离 daemon、独立 ORBIT_HOME/ORBIT_DATA、自动空闲端口；click-test、click-button、click-checkboxes、enter-text、choose-list 五任务 empty 均 valid 0；bid 脚本 click-test 正校准 valid 1。另验 provider 异常 invalid、重查与取消清理；不是模型 Agent。 |
| CLI/MCP 真实协议 | `browsergym-bridge.docker.test.ts` | passed | 4/4：真实 Chromium + 显式脚本客户端，MCP initialize/list_tools/四工具调用、重复 act 不重复 step、finish 后拒绝、Agent 未 finish 的 hook 补齐、取消 SIGTERM 收尾、伪造 archive 拒绝。 |
| 真实 CLI Agent | `browsergym-cli.docker.test.ts` | passed | 签名最终实现的 Claude Code 在上述五任务、seed 1、bid（截图+a11y）、12 步条件下全部完成且 valid，原版 reward 成功率 5/5（100%，开发校准而非基准结论）。存在真实 tool_call 与 action_id；私钥不在产物、staging 已清理后重评仍 valid 且分数一致。 |
| 证据隔离 / 失败分类 | `32d5135` | passed | main 无 /adapter、/miniwob、/evidence 挂载；真实容器中的显式测试客户端预建 collect 目标并伪造自洽 reward/哈希及 policy_setup 错误阶段时，验证失败且 score=null、invalid、scorer_error；独立针对性真实回归通过。 |
| 清理 | 真实协议与 CLI 套件 | passed | 等待 cleanup=done，再确认租约释放和本次 Run 标签对应 container/network/volume 均无残留；另按本线所有独立目录（含早期认证失败与 UI 检查）复核 daemon 均停止，并同时核对 orbit.run/orbit.parent 标签残留为 0；未触碰其他 Docker 资源。 |
| Web 组件与输入边界 | `fb4645f7` | passed | 初次交付 Web 60/60；GUI 动作解析/精确 id（含短 id）、契约/parser 一致、路径/空帧/维度/时间校验、媒体缺失与视频实际流字节预算。 |
| 会话对齐复查 / 全仓库验证 | 本次复查 | passed | 错误 step 与连续 tool_result 回归先失败、修正后通过；pnpm verify 通过（Orbit 422、Web 61、构建）；BrowserGym 宿主单测 28 通过、1 因 Python 3.10 缺 tomllib 跳过。此修正不改变执行协议，模型结果沿用上表；新主线的 Docker 回归见下一行。 |
| P4 主线集成复查 | main `4993f5f` / `9207f5d` | passed | 已 rebase 新 main；状态文档保留 P4 与 GUI 两边进展。pnpm verify：Orbit 425、Web 61，类型/边界/构建通过；固定既有镜像的真实 Chromium CLI/MCP 协议 4/4 再通过（显式脚本客户端，无模型调用）。本轮 5 个 Run 全部 cleanup done、租约 released，无 orbit.run/orbit.parent 资源残留，测试 daemon 已停止。 |
| 真实浏览器查看 | `fb4645f7` | passed | 隔离 Orbit 中的 Chromium 打开真实 Claude step 与显式 GUI/具身 fixture；确认比例叠加、对应会话、双相机、video currentTime=0.2s 定位、uPlot 和紧凑布局，无 pageerror。仓库外保留 gui-agent-session.png、gui-overlay.png、episode-timeline.png 与 browser-check.json，交付时提供位置。 |
| Codex GUI 模型连接 | 签名前开发前置检查 | failed | 已尝试，但现有认证/容器模型连接未通过；没有冒称完成 GUI 任务或开启其 gui 能力。可复现的核心识别缺口见 Next。 |
| 其他 CLI / 实际具身 adapter | 本任务范围外 | not_run | 其余 CLI 未逐一真实验证；具身仅实现约定格式和视图，后续由主线 adapter 生产索引。 |

## Next / open issues

- 主线核心：保护 service collect 的目标目录。main 可预建 `output/services/gui/evidence`，当前 docker cp 会把服务目录复制到其子目录；本 adapter 的签名阻止伪分，但不修复通用收集器。应由 daemon 选择独占目标并拒绝不可信目录/符号链接。
- 主线核心：补充结构化 CLI 模型故障识别。实测认证拒绝/连接失败导致 Agent 未产生动作，结束 hook 的原版 noop 仍能留下完整证据；现有核心未识别时可能作为有效方法失败进入评分。应根据可信、脱敏的模型失败证据判 invalid，不能用“退出失败且无动作”代替识别（合法思考超时/主动失败应正常评分）。
- 主线核心：文件 API 的视频 MIME/Range；当前 Web 总计 64 MiB 有界预览，更大文件需下载。不可中断环境调用/SIGKILL 不能保证 finish，保持缺证据 invalid，不支持恢复。
- 主线文档与 adapter：将本文动态 goal、证据签名与 episode 契约同步进 design.md；vla-eval/EFE 后续产出该索引。docs/design.md 与其他 adapter 不在本线白名单，未修改。
