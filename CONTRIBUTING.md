# Contributing

Read [AGENTS.md](AGENTS.md), [project status](docs/project-status.md), the relevant task record,
and [the documentation map](docs/README.md) before changing files.

## Development environment

The tested baseline is Linux x86_64, Python **3.12.14**, Node **24.18.0**, uv **0.12.10**,
and pnpm **10.32.1**. Git and Make are required. Other platforms are not yet validated.
Runtime versions live in the root version files; package managers are pinned in
pyproject.toml and package.json. Do not change system Python or shared server tooling.

If uv is missing, install the pinned version using the
[official uv installer](https://docs.astral.sh/uv/getting-started/installation/).
An existing uv installation can provision Python with `uv python install 3.12.14`.
Install the Node version from [.node-version](.node-version) through your existing
version manager or the [official Node distribution](https://nodejs.org/en/download).
If your Corepack shim works, running pnpm inside this repository selects the pinned version.
Otherwise install it into a user-owned prefix and put that prefix first on PATH:

```sh
npm install --global --prefix "$HOME/.local" pnpm@10.32.1
export PATH="$HOME/.local/bin:$PATH"
```

Run from the repository root:

```sh
make setup
make verify
uv run --locked python scripts/ci/smoke_wheel.py
uv run --locked agent-infra config-check --config configs/defaults.toml
make dev-web
```

The Web development server binds to 127.0.0.1:5173 and fails if the port is occupied.
Use `make dev-web WEB_PORT=5174` for another worktree; use SSH forwarding when browsing
from a remote workstation. Stop it with Ctrl-C. This starts the frontend development server only.
For the local Controller, built Web console and Docker experiments, follow
[direct experiments](docs/operations/direct-experiments.md); use
[the upgrade runbook](docs/operations/python-upgrade.md) before changing an existing deployment.

## Work isolation and review

Create a task branch from the current main before editing; never develop directly on main.
Concurrent agents use separate sibling worktrees; different humans use separate clones.
For example, with a clean main checkout:

```sh
git worktree add ../infra-agent-session -b feat/agent-session main
cd ../infra-agent-session
make setup
```

Use a unique `AGENT_INFRA_STATE_DIR`, Web port and (when implemented) service namespace.
Worktrees do not reserve CPU/GPU resources. Check actual available resources before runtime tests.

Create a significant-task record before implementing. Keep changes within the assigned module,
its tests and docs. Public contracts belong in the provider module's `api.py` or `api/`;
small shared references belong in `contracts/`. Agree changes with consumers before implementation.
Read the existing producer and consumer contracts before adding a new interface.

The import-linter contract in pyproject.toml enforces dependency direction and independent peers:
bootstrap → gateways → projects → runs → benchmarks → agents/tasks → environments/resources → records → contracts.
The same-level pairs cannot import each other. An allowed direction does not authorize importing
private backend code: callers use public contracts; bootstrap assembles concrete dependencies.
S1 must add public/private contract checks with the first actual interfaces. Dynamic imports are
not a permitted workaround and are not covered by the static graph.

Benchmark adapters use the designated external-package extension boundary, not dynamic imports
between core modules. An operator enables a pinned distribution and versioned entry point;
planning adapters import `agent_infra.benchmarks.api` and the public conformance helper.
The optional BM01 execution extension additionally uses `benchmarks.execution_api` and
`environments.api.ProcessCommand`, never Run or backend implementation internals.
See [adapter authoring](docs/development/benchmark-adapters.md). The existing wheel smoke check
also builds and installs the independent example adapter in a disposable environment.

Tests follow `tests/unit/<module>/`, `tests/contracts/`, `tests/integration/` and `tests/e2e/`;
the foundation tests currently sit directly in unit/contracts. Test doubles belong in
`tests/fakes/`, small fixed inputs in `tests/fixtures/`. Frontend behavior tests live in
`tests/web/`; the smoke scripts use Playwright and an available Chromium installation.
They exercise real HTTP/browser code with explicitly fake execution, without model calls.
`make verify` covers frontend lint, generated-contract drift, types and the production build;
browser smoke and Docker E2E are separate checks.

`make check` is read-only formatting/lint/types/import/docs verification.
`make test` runs deterministic checks without external services.
`make build` builds both distributions; `make verify` runs all three.
`make format` writes formatting fixes; use it within a scoped change and review the diff.
Integration/e2e checks are explicit opt-in; mark them and document real resource budgets.

Update dependencies with `uv add` / `uv add --dev` or
`pnpm --filter @agent-infra/web add`. Commit manifests and generated locks together.
After lock conflicts, reconcile manifests, regenerate with the pinned manager, and inspect the diff.
Do not hand-edit locks or install an unpinned alternate toolchain to make checks pass.

Before handing off, inspect the full diff, run relevant checks, finalize the task record, and
update project status if capabilities changed. Commit only task files; publishing and merging
follow the user's authorization. PRs target main and use the repository template.

## GitHub activation

The workflow runs `make setup`, `make verify`, and wheel smoke on every PR and main push.
The stable job name is `foundation`; select the actual resulting check in GitHub settings.
There is no path filter that could leave a required check pending.

The maintainer must verify a successful hosted run after publishing, then configure a main
ruleset requiring PRs, the foundation check, appropriate independent/code-owner review, and
blocking force pushes/deletion. Ensure every required reviewer has repository access.
CODEOWNERS currently routes review to @XuehaiWang; replace module patterns with real accounts
when contributors join. CODEOWNERS and local checks do not enforce server-side branch protection.
This task does not modify hosting settings or claim those protections are active.

## Configuration and secrets

Built-in defaults → explicit `--config` TOML file → `AGENT_INFRA_*` environment overrides.
Only `state_dir` (non-empty path) and `log_level` (DEBUG/INFO/WARNING/ERROR/CRITICAL) exist.
Unknown TOML keys and invalid values fail. Paths resolve from the invoking working directory.
`config-check` prints only these two settings and creates no directories or services.
`.env.example` documents optional shell variables; files named `.env` are not automatically loaded.
Keep real configuration in ignored configs/local/ and runtime artifacts in var/ or an external
state directory. Do not add authentication tokens to tracked configuration or documentation.
