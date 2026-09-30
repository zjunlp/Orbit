---
record_version: 1
task_id: "20260930-python-research-core-8e12c4"
title: "Incremental Python research execution and review refactor"
branch: "refactor/python-research-core"
base_commit: "920ee1d44aeee2d9b02bdd208dbf4abede343e67"
work_status: in_progress
updated_at: "2026-09-30T04:16:36.769628+00:00"
pull_request: null
---

## Goal and acceptance

- Implement the [incremental refactor](../development/python-incremental-refactor.md): direct
  command experiments, durable resource admission, shared evidence and review, provider-neutral
  host sessions, and removal of redundant production paths while preserving native benchmarks.
- Keep existing CLI/data compatibility. Verify failures, cancellation, recovery, and historical
  queries, as well as successful execution. Keep implementation and real-runtime evidence distinct.

## Changes

- Confirmed annotated tag `pre-python-refactor-20260929` resolves to the base commit.
- Isolated work in the sibling `infra-wt-python-refactor` worktree; imported the reviewed plan.
- Extracted common durable execution lifecycle into `runs/execution.py`; the native benchmark
  facade retains its request format and protocol validation; checkpoint `683efb1`.
- Added command submission, source snapshots, a Docker backend over the existing process supervisor,
  project attachment, CLI/HTTP/MCP entrypoints and shared node lease admission. Integration hardening
  is complete; whole-repository verification passed; documentation finalization is in progress.
- Added a derived metrics index and provider-neutral native session capture with Codex compatibility
  and Claude parent/child identity. Project schema v6 migration, replay, metrics, resource and legacy
  catalog regressions pass. New catalog writes belong to Projects; old files stay read-only.
- Added typed review/session responses, generated TypeScript with a drift check, project metric
  comparison, code/configuration review, explicit current-code reruns and native session views.
- Made model proxy setup lazy for plain command use; preserved benchmark native protocols and
  separate external scheduler accounting. No production service or runtime data was changed.

## Decisions

- Preserve Python module boundaries and the independent native benchmark adapters. Reuse durable
  execution and Docker implementations rather than adding a parallel scheduler or runtime.
- Preserve historical data and the existing TS worktree. No real model calls are needed for
  deterministic implementation checks; any paid acceptance needs an explicit task budget.
- Keep governance unchanged; document source-level and data compatibility with each checkpoint.

## Validation

| Check or command | Tested revision or snapshot | Result | Evidence or limitation |
| --- | --- | --- | --- |
| `git rev-parse pre-python-refactor-20260929^{}` | base commit | passed | Exact base commit above. |
| `uv sync --locked --offline`; `pnpm install --frozen-lockfile --offline` | base commit | passed | Isolated worktree dependencies installed from cache. |
| `make verify` | base commit | passed | 428 tests passed; 33 integration/e2e deselected; lint, typing, boundaries and builds passed. |
| `pytest tests/unit/benchmarks/test_execution.py -q` | execution-kernel extraction workspace | passed | 17 tests; no Docker/model execution. |
| Resource/Controller/benchmark focused regression | command/resource workspace after `683efb1` | passed | 58 tests; no model calls. |
| `pytest tests/unit/runs/test_commands.py -q` | direct command workspace | passed | 5 tests. |
| Real local Docker command smoke | command workspace before metrics/session additions | passed | 1 CPU/256 MiB, no GPU/model. Exit 0 and exit 3 both retained logs/partial artifacts and released leases after confirmed cleanup. `/tmp/infra-command-smoke.log`; temporary state `/tmp/infra-refactor-command-3qftuzpr`. |
| Final focused unit regression | pre-delivery workspace after kernel checkpoint | passed | 34 tests; includes GPU identity/count-only exclusion, external/local admission separation, index-failure release, snapshots, migration and HTTP review. `/tmp/infra-refactor-final-focused.log`. |
| `pytest -q tests/e2e/test_direct_commands.py` | same workspace; latest CLI and snapshot changes | passed | 2 real local Docker tests, 1 CPU/256 MiB maximum, no models/GPU. Same Run/lease after forced Controller restart, EOF tail, readable metrics, rerun exit 3, cancellation, timeout and partial artifacts. `/tmp/infra-refactor-real-final.log`. |
| Review, legacy research and benchmark browser smoke | review workspace | passed | Real Chromium/HTTP with explicit execution fixtures, no model/Docker; comparison, rerun, native session, navigation, narrow screen, legacy planning, ASI/TB-style batch/evidence views. Final rebuilt review page also passed (`/tmp/infra-refactor-review-final.log`). |
| Historical source read through new code | current workspace + read-only existing state | passed | first-study: 48 events, 2 artifacts and derived trajectory readable. ASI b3: 60 finished Runs and all 60 artifact manifests readable. `/tmp/infra-refactor-history-read.log`; no migration or writes. |
| CPU direct-command example | current workspace, temporary output directory | passed | 21 metric rows, decreasing loss and matching final summary; no model/Docker. |
| `make verify` | implementation workspace before final metric-overflow/UI polish | passed | 445 tests, 35 integration/e2e deselected; lint, format, imports, mypy, codegen drift, TypeScript, document links and both builds. One existing MCP/Pydantic deprecation warning. `/tmp/infra-refactor-verify-final.log`. |
| Final metric-overflow and review regression; `pnpm check`; `pnpm build`; Ruff | final implementation snapshot | passed | 2 focused tests, frontend codegen/type/build, and final review browser. Non-finite oversized numbers skip safely; completed reviews stop polling; single-point chart coordinates use the shared scale. `/tmp/infra-refactor-final-polish.log`. |

## Open items and blockers

- Complete the distribution smoke check and finalize the operation/implementation guides, overview and delivery record.
- No Git permission blocker remains. Production state and services have not been modified.

## Next steps

- Commit the reviewed implementation snapshot, then finalize documentation and record the exact tested commit.
  Integration into main and production deployment remain separate actions.

## Compatibility and rollback

- Main remains unchanged. Revert individual task commits or use the base tag for code rollback.
- Projects schema v6 migrates old Codex bindings once and adds the project-owned catalog projection;
  old Codex rows are retained. Lease schema v2 keeps empty new fields out of old claim identities.
  Drain old local jobs and stop old writers before upgrading. Back up state and the shared node ledger.
- Commands can reattach after Controller restart; old frozen Task/long-term environments keep their
  interruption-and-cleanup policy. Metrics are derived; original evidence remains authoritative.
- Code rollback alone does not downgrade databases. Stop task-owned work and restore the pre-upgrade
  state backup when returning to a version that cannot read the new schema.
- Do not delete old runtime state or rewrite benchmark aggregation/protocol semantics.
