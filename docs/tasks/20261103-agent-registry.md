# Agent 注册表与自定义 Agent
branch: feat/agent-registry, fix/agent-bench-contract · status: in_progress · updated: 2026-11-03

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

## Correction (fix/agent-bench-contract)

Review ([design-review.md](../design-review.md) R1) found the first change incomplete: `Method.agent` and
`BenchCapabilities.methods` were still a five-value enum, so bench jobs rejected every new Agent; the install
script returned by `prepareAgent` was never executed; and ASI mapped every non-Codex CLI to Claude. The earlier
claim that bench methods could name any registered Agent was wrong. Fixed:

- `Method.agent` accepts any Agent name; `external/oracle/empty` stay special, `policy` is reserved and refused;
  the registry refuses reserved names; jobs check registration and auth kind before submission.
- Capabilities keep concrete names exact (`["codex"]` still means only Codex); `cli` explicitly admits all CLIs.
  Daemon and Web share the rule (`capabilityAllows`); the Web method list comes from `GET /agents`.
- Docker runs execute the `install` script before the command (`NPM_CONFIG_PREFIX` in the Agent home,
  `~/.local/bin` on PATH, log in `orbit/agent/setup.log`); a failed install sets reason `Agent install failed`,
  which bench classifies as an environment failure without verify. Process runs refuse `install` Agents.
- Preflight requires a host CLI only for `host` Agents. ASI and LongDS refuse Agents they do not adapt.
- dsh resume uses `--session-id` (checked against `dsh headless --help`).

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | working tree | passed | 410 orbit tests (17 skipped) + 51 web; new `agent-bench.test.ts` |
| Contract: pi, kimi-cli, my-agent accepted; policy and reserved names refused | working tree | passed | unit tests |
| Install wrapper success/failure exit codes | working tree | passed | test caught `if !` losing the exit code; fixed |
| Real Harbor-format trial: empty / oracle / dsh | working tree | passed | empty 0, oracle 1, dsh 1/1 valid; dsh 0.2.1-rc.5 installed in the container (host has rc.2); no key in the log; cleanup done |
| First dsh attempt with the default npm registry | working tree | failed | install still running after 19 min from this network; cancelled. Retried with `-e NPM_CONFIG_REGISTRY=…` on the auth profile |
| Real install failure in Docker | — | not_run | covered by the shell-level unit test only |
| Other install Agents (pi, opencode, kimi-cli, …) | — | not_run | |

## Next / open issues

1. Ten built-in definitions are transcribed from the CLIs' own flags and Harbor's adapters, not run here.
   Each needs `orbit agent test` before `verified: true`; `pi` in particular is pinned to Harbor's supported
   package range (`@mariozechner/pi-coding-agent`, ≥0.74).
2. Session parsing is still codex/claude-code only. Other Agents record `transcript.glob` + `format: jsonl`
   but no parser reads it yet, so their Web Session page stays empty and `runAgentFailure` sees only logs.
3. `install` Agents need network and a toolchain in the task image, and install `latest` each run (versions drift;
   recorded only in the Agent home). Slow registries need `NPM_CONFIG_REGISTRY` / `UV_INDEX_URL` on the auth
   profile. Pinning versions and caching installs are open.
4. The next step of the expansion plan (Env kind + `orbit-env` tool bridge) depends on this registry: it is what
   lets a CLI Agent drive a GUI or simulator environment. The workspace/answer/session kinds come after.
