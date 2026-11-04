# P6 + P5-Web：CLI Agent 的 GUI 桥与场景化 Trial 视图（并行线 B）
branch: feat/p6-cli-agent-bridge · status: in_progress · updated: 2026-11-04 · owner: Codex（主线由 Claude 负责）

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

## Changes

（实现后填写）

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |

## Next / open issues
