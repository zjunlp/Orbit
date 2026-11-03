# Agent 注册表与自定义 Agent
branch: feat/agent-registry · status: in_progress · updated: 2026-11-03

## Goal

Orbit 原先只能驱动 Codex 与 Claude Code：`Method.agent` 是二值枚举、auth profile 的 `harness` 是枚举、
`harness/agentCommand` 只为两者生成命令。任何第三种 Agent CLI 都无法表达，ASI / Harbor 格式 / 后续的
Env kind 都被这一层卡住。

目标：把 Agent 从代码里的分支改成声明，使 `codex`、`claude-code`、`pi`、`opencode`、`kimi-cli`、
`gemini-cli`、`aider`、`goose`、`qwen-code`、`copilot-cli`、`mini-swe-agent`、`dsh` 以及用户自带的
Agent 走同一套安装、认证、argv 与会话路径。

## Changes

- `contracts/agent.ts`（新）：`AgentDefinition`（`install` host/install/image、`auth`、`command` 模板、
  `capabilities`、`verified`/`origin`）、`AgentInfo`/`AgentList`、`AgentName`；`AuthKind` 移到
  `contracts/common.ts`，避免 `auth.ts` ↔ `agent.ts` 的循环导入。
- `contracts/auth.ts`：`Harness` 由二值枚举改为 `AgentName`；`contracts/runs.ts` 的 `AgentRef.harness` 与
  `RunCheckpoint.session.harness` 同步放开为已注册名。
- `harness/definitions.ts`（新）：12 条内置定义。命令行、安装命令、认证变量与会话位置对照 Harbor
  `agents/installed/`（`f6cf2e2`，2026-11-03）。`renderTemplate` 支持 `{instruction}` `{model}` `{effort}`
  `{session}` `{home}` 与 `{when:key} … {end}` 可选参数组；`definitionProblem` 在写入前校验占位符与配对。
- `harness/registry.ts`（新）：`AgentRegistry`（内置 + `~/.orbit/agents.json`，0600，内置名不可覆盖）、
  `host()`（宿主定位与版本，按 daemon 生命周期缓存）、`info()`、`renderCommand()`、`builtinRegistry()`。
  `install.kind = host` 的 CLI 若是 Node 脚本，可同时挂载 daemon 的 Node 运行时。
- `harness/index.ts`：`prepareHarness` → `prepareAgent(def, entry, agentDir, { hostCli })`，注入由定义的
  `auth` 决定；`agentCommand`/`resumeAgentCommand` 改为按定义渲染；`finishHarness` 额外清掉注册 Agent home
  顶层的常见凭据文件。codex / claude-code 保留各自配置文件写法，其余 Agent 只走通用路径。
- `runs/`：`RunServiceDeps.agents`、`launch.prepareAuth` 查定义、`installBundle` 改为按定义目录、
  `preflight.localBlocker` 与 `checkpoint.resumeSpec` 改走注册表（无注册表时用内置定义，便于嵌入与测试）。
- `bench/`：`toRunSpec` 增加 `agentDef`（惰性，`empty`/`oracle`/`external` 不触发查找）；
  `BenchServiceDeps.agents`；`checkMethod` 不再比较 harness 枚举。
- `daemon/`：`AppDeps.agents`、`GET/POST /agents`、`GET/DELETE /agents/:name`、`doctor` 逐 Agent 报告可用性、
  cluster 心跳按定义的 install 类型判断 CLI 是否存在。
- `cli/agent.ts`：新增 `orbit agent ls|show|add|rm|check`（与原 `detectAgent` 提交者识别共存）。
- 文档：`docs/design.md` §6 重写为 Agent 注册表，§7 Method 与 §5 会话关联同步；`docs/status.md` 记录新能力与
  未验证范围。

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify`（biome, tsc, boundaries, vitest, build） | working tree | passed | 418 orbit tests（401 passed, 17 skipped）+ 50 web tests |
| `orbit agent ls` on this machine | working tree | passed | 12 definitions listed；codex `codex-cli 0.166.0`、claude-code `2.1.317` detected from the host |
| `orbit agent add` of a custom definition | working tree | passed | stored and listed as `missing` with exit 1 from `agent check`（binary absent） |
| Definition validation | working tree | passed | unknown placeholder and a built-in name are both rejected with a clear message |
| Real run with a non-built-in Agent | — | not_run | needs a host CLI; none of pi/opencode/kimi/gemini/aider/goose/qwen/copilot/mini-swe/dsh is installed here |
| Bench trial with a non-built-in Agent | — | not_run | follows the Agent run check |

## Next / open issues

1. Ten built-in definitions are transcribed from the CLIs' own flags and Harbor's adapters, not run here.
   Each needs `orbit agent test` before `verified: true`; `pi` in particular is pinned to Harbor's supported
   package range (`@mariozechner/pi-coding-agent`, ≥0.74).
2. Session parsing is still codex/claude-code only. Other Agents record `transcript.glob` + `format: jsonl`
   but no parser reads it yet, so their Web Session page stays empty and `runAgentFailure` sees only logs.
3. `install` Agents need network and a toolchain in the task image; a failing install currently fails the run
   as an environment error (correct, but the message should name the install step).
4. The next step of the expansion plan (Env kind + `orbit-env` tool bridge) depends on this registry: it is what
   lets a CLI Agent drive a GUI or simulator environment. The workspace/answer/session kinds come after.
