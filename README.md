# Agent Infra

A modular infrastructure project centered on **Agent** and **Environment**, coordinated through
Run, Tasks, Resources and Records, with thin protocol gateways and a Web console.

The current prototype includes replaceable Codex, Claude Code and DeepSeek Harness adapters,
Tasks and single-node Resources, a local Docker Run/Environment slice, durable Records, and
a simple local research Web console. A local controller now connects compiled research Tasks to
container Codex execution, persistent status, cancellation, trajectories and downloadable results.
The Web console shares project initialization, adopted experiments, preflight, submission, cancellation
and result analysis with the CLI. Existing code can also run directly in Docker, without a research
plan: durable admission, code snapshots, cancellation, restart reconciliation, metrics comparison,
and explicit reruns share the existing execution and Records infrastructure. Host Codex and Claude
sessions can be explicitly bound and incrementally collected. Bounded iteration remains optional;
distributed execution remains pending.
See [project status](docs/project-status.md) for acceptance and integration state.

Local project initialization is also available: preserve a research goal, create its workspace,
and reopen or recover it without an Agent, Docker, or a running server.

For the shortest existing-code workflow, follow [direct experiments](docs/operations/direct-experiments.md)
and the deterministic [CPU example](examples/research/direct-command/train.py).
For a planned Codex CPU experiment, follow the [statistics example](examples/research/cpu-statistics/README.md).
See the [Run controller commands](docs/reference/local-run-controller.md) and
[implementation guide](docs/implementation/local-run-controller.md) for setup and recovery.

## Quick start

Prerequisites: Linux, Git, Make, Python 3.12.14, Node 24.18.0, uv 0.12.10 and pnpm 10.32.1.
Tool installation and worktree guidance: [CONTRIBUTING.md](CONTRIBUTING.md).
Run from the repository root:

```sh
make setup
make verify
uv run --locked python scripts/ci/smoke_wheel.py
uv run --locked agent-infra --version
uv run --locked agent-infra config-check --config configs/defaults.toml
uv run --locked agent-infra agent doctor codex
uv run --locked agent-infra agent doctor claude-code
uv run --locked agent-infra agent doctor dsh
uv run --locked agent-infra resource inspect
uv run --locked agent-infra resource validate examples/resource-requests/single-gpu.yaml
pnpm build
uv run --locked agent-infra web
```

Open the token-bearing local URL printed by the Web command (port 8765). It provides host
resource monitoring, research workspaces, plans, experiments, results and analysis, plus legacy
project/milestone editing. Use the same `--state-dir` as your project commands. To execute experiments,
start `agent-infra controller serve --state-dir <same-directory>` in another terminal with your
authorized CPU/memory budget; the Web does not start the controller automatically.
See the [Web console guide](docs/operations/web-console.md) for task registration, existing Records,
SSH forwarding and current limits. Ctrl-C stops the console. `make dev-web` remains the isolated
Vite frontend development entrypoint without a default backend proxy.

`make check` runs format, lint, type, import-boundary, policy-parity and local document-link checks.
`make test` runs deterministic tests without external services. `make build` produces a Python
wheel/source distribution in `dist/` and Web assets in `src/web/dist/`. `make verify` runs all three.
Install commands require registry access (or populated caches); CI uses the same commands.

To start a research project in a new directory:

```sh
uv run --locked agent-infra init ./position-encoding \
  --name "Position encoding study" --goal "Compare position encodings on long-context tasks"
uv run --locked agent-infra project show ./position-encoding
```

Omit the directory to derive it from `--name`; omit both to generate a unique directory.
Add `--dry-run` to preview without writing. Existing directories are never overwritten.
The workspace contains `docs/`, `code/`, `configs/`, `data/`, `runs/` and `artifacts/`.
See [project initialization](docs/reference/projects.md) for state storage, retries and recovery.
To plan with an Agent, install the project-local research skill and resume from saved context:

```sh
uv run --locked agent-infra project research skill ./position-encoding --install
uv run --locked agent-infra project research context ./position-encoding
```

Research drafts, experiment proposals, revisions and user decisions are durable. See the
[research planning guide](docs/reference/research-planning.md). Adopted experiments can be compiled
into frozen Tasks with `agent-infra project compile`; see the
[compilation guide](docs/reference/experiment-compilation.md) and
[code walkthrough](docs/implementation/project-workflow-code-guide.md).
The Web project page can compile adopted experiments and submit them to the local controller.
Legacy catalog entries remain intact and can be explicitly linked to an initialized workspace.

To run existing code, start the Controller with the same state directory and use:

```sh
uv run --locked agent-infra run command --state-dir /absolute/infra-state \
  --project /absolute/research --image python:3.12-slim \
  --cpu 1 --memory-gib 0.25 --timeout 60 --wait -- python train.py
```

The image must exist locally and include `python3` and the script's dependencies. The workspace is
snapshotted; write results to `outputs/`, metrics to `outputs/metrics.jsonl`, and mount datasets
explicitly read-only. The project page compares recorded experiments and offers a confirmed rerun
using current code. See the [implementation guide](docs/implementation/python-research-core.md)
for shared node quotas, recovery, legacy compatibility, and upgrade/rollback requirements.

## Code organization

```text
src/agent_infra/
  projects/        Research project identity, workspace initialization and recovery
  agents/          Agent sessions and backend adaptation
  environments/    Workspaces, execution and environment lifecycle
  runs/            Run/Attempt orchestration
  tasks/           Task parsing, visibility and native evaluation
  resources/       Allocation, leases and dispatch
  records/         Durable metadata, events and artifact references
  contracts/       Small shared contracts, introduced in S1
  gateways/        CLI, HTTP, MCP and Worker protocol boundaries
  bootstrap/       Configuration and dependency assembly
src/web/           React/TypeScript frontend
```

The backend implements initial public contracts and local workflows across the functional modules.
See project status for validation scope and remaining integration gaps.
Cross-module calls use public contracts; concrete backends are assembled in bootstrap. The static
dependency graph is enforced by import-linter; finer public/private boundaries accompany S1
contracts.

`tests/` holds validation; `configs/` holds safe tracked configuration; `scripts/` holds developer
and CI utilities. `deploy/`, `examples/` and `schemas/` reserve deployment, examples and generated
contract locations for later stages. `.github/` holds CI and review configuration.
Runtime data belongs in ignored `var/` or an external state directory. See
[the documentation map](docs/README.md) for document placement.

## Configuration

`agent-infra config-check` validates built-in defaults, an optional explicit TOML file, then
`AGENT_INFRA_STATE_DIR` / `AGENT_INFRA_LOG_LEVEL` environment overrides. It prints the resolved
non-sensitive settings without creating state or starting services. `.env` is not auto-loaded.
See [contributor configuration guidance](CONTRIBUTING.md#configuration-and-secrets).
Project, Controller and Web commands share `--state-dir` / `AGENT_INFRA_STATE_DIR`, falling back to
`$XDG_STATE_HOME/agent-infra` or `~/.local/state/agent-infra`; `config-check` uses this default too.
Runtime commands do not read the TOML file. `configs/defaults.toml` explicitly selects `./var`
for its example; use `--state-dir` or the environment to select that directory at runtime.
Explicit state paths must use real directories rather than symlinks. Web and Controller create
their shared `controller/` directory privately; existing directories with broader permissions
require an ownership check and mode `0700` before startup.

## Design and development

- [Agent/Environment architecture](docs/architecture/agent-environment-modules.md)
- [Agent module and replaceable CLI integrations](docs/architecture/agent-module.md)
- [Resource management, Docker and Ray design](docs/architecture/resource-management.md)
- [Environment, cluster, trace and execution-mode questions](docs/architecture/environment-operations-qa.md)
- [Development sequence](docs/development/development-sequence.md)
- [Current implementation and capability review](docs/implementation/current-code-and-capability-review.md)
- [S0 plan and acceptance](docs/development/s0-engineering-foundation.md)
- [Four-person collaboration plan](docs/development/four-person-collaboration.md)
- [Agent rules](AGENTS.md), mirrored in [CLAUDE.md](CLAUDE.md)

Develop on task branches and include significant-task records. Publishing and PR merges follow
the agreed authorization and review workflow. CODEOWNERS requests review; it does not activate
branch protection. Hosted CI and main rulesets must be verified on GitHub after publishing.

License selection is pending; the empty LICENSE file grants no license.

### 宿主机 Agent 通过 MCP 做科研

H 批提供项目绑定的长期 Docker 环境、后台 Job、日志、文件与产物操作。
入口为 `agent-infra mcp`（stdio）和 `agent-infra research`（人工 CLI），连接独立 Controller。
可使用已有 Python 3 镜像，或通过 E 批准备并验证依赖环境；当前 CPU、单活跃 Run，关闭 MCP 不停止 Job。
具体启动和 Codex 配置见[宿主机科研指南](docs/reference/host-research-mcp.md)，
代码维护见[实现导读](docs/implementation/host-research-mcp.md)。

### 自动准备科研环境

`agent-infra environment` 支持固定需求、依赖提案、Python CPU 模板构建、独立 smoke、日志和取消。
Agent 可以通过同一 MCP 读取错误并在原预算内修订；验证通过的锁可用于 H 长期环境或 D 的冻结 Task。
目前支持公开 PyPI wheel 和已有 Agent 基础镜像，不支持任意 Dockerfile、GPU 或系统包自动构建。
见[环境准备使用说明](docs/reference/environment-preparation.md)和[维护导读](docs/implementation/environment-preparation.md)。


Research iteration supports evidence-backed analysis, explicit next-plan decisions and bounded
execution of preauthorized frozen tasks. Use `agent-infra study --help` and
`agent-infra planner --help`; a disposable container Planner shares the Controller resource quota.
See [the usage guide](docs/reference/research-iteration.md) for prerequisites, budgets and recovery.
