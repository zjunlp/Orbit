---
record_version: 1
task_id: "20260930-python-research-core-8e12c4"
title: "Incremental Python research execution and review refactor"
branch: "refactor/python-research-core"
base_commit: "920ee1d44aeee2d9b02bdd208dbf4abede343e67"
work_status: in_progress
updated_at: "2026-09-30T11:30:00+08:00"
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
  facade retains its request format and protocol validation. Direct command support is in progress.

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

## Open items and blockers

- Complete the execution, resource, evidence, session and Web changes and their validation.
- No Git permission blocker remains. Production state and services have not been modified.

## Next steps

- Finish baseline verification, extract the common durable execution kernel, and add direct
  command submission using the existing Docker backend and public execution contracts.

## Compatibility and rollback

- Main remains unchanged. Revert individual task commits or use the base tag for code rollback.
- Database changes require versioned, repeatable migrations; validate on temporary state first.
- Do not delete old runtime state or rewrite benchmark aggregation/protocol semantics.
