---
record_version: 1
task_id: "20260930-cleanup-and-upgrade-c83f21"
title: "Audit redundant code, integrate the Python refactor and upgrade local services"
branch: "chore/python-cleanup-upgrade"
base_commit: "53ef8934dbe9c1c756a9d06dd397694f615f9e19"
work_status: in_progress
updated_at: "2026-09-30T14:34:00+08:00"
pull_request: null
---

## Goal and acceptance

- Audit the whole tracked code/test tree; remove confirmed dead or redundant implementation and
  tests while preserving useful regression coverage, historical data readers and native protocols.
- Review and validate the [Python refactor](20260930-python-research-core-8e12c4.md), then merge it
  through the repository's review workflow. The independent TypeScript rewrite is outside scope.
- Back up the deployed state and resource ledgers, confirm old leases/workloads are drained, then
  upgrade local services. Verify service health, historical records and the direct experiment path.
- Preserve unrelated workloads, existing results and credentials. No paid model or GPU executions.

## Changes

- Started a cleanup branch from the completed Python refactor in its existing isolated worktree.
- Initial runtime inventory: the personal Web process listens on 127.0.0.1:8765; no Controller
  listener is running. Three running Docker containers belong to another project and are excluded.
- Removed the unused `LocalProjectCatalog` writer, Codex-specific binding wrapper, old rollout
  lookup/workspace helpers, task inspection wrapper, four unused icons and five empty placeholders.
  The documented `LocalRunJournal` compatibility export and Codex CLI/notify remain supported.
- Web/record tests now use the production Projects catalog bridge. A small fixed-schema fixture
  seeds old SQLite files for migration tests; no duplicate legacy database implementation remains.
  Existing behavior cases stay covered rather than being deleted just to reduce test count.
- Session lookup filters at the database, and task catalog reads use one snapshot. During review,
  fixed the benchmark overview's omission of scoped shared-node leases; reads remain non-mutating
  and exclude other scopes, verified by a dedicated regression.
- Updated the maintainer guide and contributor startup/testing descriptions; added the
  [upgrade and rollback runbook](../operations/python-upgrade.md).

## Decisions

- Distinguish dead implementation from compatibility readers and explicit integration fixtures.
  Remove code only after checking its imports, entrypoints and consumers.
- Keep development off main. User authorized review, merge, state backup/drain and upgrade.
- The existing baseline tag is `pre-python-refactor-20260929` at `920ee1d`.
- Whole-tree audit used tracked-file/import/reference inventories, AST duplicate/dead-definition
  candidates, frontend export references and manual producer/consumer review. Protocol callbacks,
  validators, native benchmark fixtures, failure/privacy tests and historical readers are useful;
  they are not removed because a static name scan cannot find their runtime invocation.
- Real state inventory found one finished personal Run and 65 finished benchmark Runs across six
  state roots; all 65 native leases are released. Old stopped Docker containers are preserved.
- Core dependency synchronization must preserve the separately installed PAST adapter (`--inexact`).

## Validation

| Check or command | Tested revision or snapshot | Result | Evidence or limitation |
| --- | --- | --- | --- |
| Git/worktree and process inventory | `53ef893`, main `920ee1d` | passed | Clean starting trees; only Python and independent TS refactors are unmerged. |
| Focused catalog/session/Web/history tests | cleanup workspace after `53ef893` | passed | 25 tests; no model or Docker calls. |
| Shared-node overview and Codex regression | final cleanup code | passed | 6 tests; includes read-only behavior and scope isolation. |
| `make verify` | final cleanup code on `53ef893` | passed | 446 tests, 35 integration/E2E deselected; lint, typing, dependencies, generated contract drift, links and builds pass. Existing MCP/Pydantic warning remains. `/tmp/infra-cleanup-final-verify.log`. |
| Workflow and review browser smoke | final cleanup code/build | passed | Chromium + actual HTTP/SQLite with explicit fake execution: legacy binding, planning, cancellation, artifacts, comparison, session views, rerun/navigation and mobile. `/tmp/infra-cleanup-workflow-browser.log`, `/tmp/infra-cleanup-review-browser.log`. |
| `UV_OFFLINE=1 uv run --locked python scripts/ci/smoke_wheel.py` | final cleanup wheel | passed | Installed package/CLI smoke and isolated external adapter wheel with four synthetic plans; no native model/runtime. `/tmp/infra-cleanup-wheel.log`. |
| Review of runtime inventory | old deployment `920ee1d` | passed | No live Controller/batch worker; 65 native leases released; unrelated Docker services preserved. |
| State backup, lease drain and upgraded service checks | None | not_run | Requires completed audit and reviewed integration. |

## Open items and blockers

- Cleanup, local regression and installed-wheel verification are complete. Finish PR integration,
  consistent backup and deployment checks before marking the overall task complete.
- GitHub branch-protection API returns HTTP 403 for the private repository's plan; do not claim
  enforced protection. Actual PR checks/review will be inspected before integration.

## Next steps

- Publish the reviewed branch, inspect hosted checks, then merge and perform the documented upgrade.

## Compatibility and rollback

- No real runtime data changed yet. Preserve historical readers and documented CLI compatibility.
- Removed internal implementation names are not public SDK exports; external code importing
  `LocalProjectCatalog` or `CodexBindingStore` directly should use the project-owned catalog and
  `SessionBindingStore`. Persisted schemas and command names are not removed by this cleanup.
- Projects v6 and lease v2 require a complete pre-upgrade state backup for downgrade; the code tag
  alone is insufficient. Record the concrete backup and restore procedure before switching services.
