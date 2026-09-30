---
record_version: 1
task_id: "20260930-cleanup-and-upgrade-c83f21"
title: "Audit redundant code, integrate the Python refactor and upgrade local services"
branch: "chore/python-cleanup-upgrade"
base_commit: "53ef8934dbe9c1c756a9d06dd397694f615f9e19"
work_status: completed
updated_at: "2026-09-30T14:48:00+08:00"
pull_request: "https://github.com/XuehaiWang/agent-infra/pull/10"
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
- Reviewed and merged the Python refactor plus cleanup through PR #10 after hosted foundation
  passed. Deployment uses `682aad3eec0e2351314fd4ca843c029a81e4b696`; the independent TS branch
  remains unchanged. The final rollout evidence is carried on `ops/python-upgrade-verification`.
- Stopped the identified old Web process after confirming no Controller/batch worker or active
  lease remained. Created a private full-state/code backup, checked all archived file hashes and
  verified all 26 copied SQLite databases before switching the deployment checkout.
- Synced locked dependencies (preserving the independent PAST adapter), built Web, and started
  the personal Controller on 8766 (1 CPU / 2 GiB total, no GPU authorization) and Web on 8765.
  Both use `/disk/disk_20T/wangxuehai/infra-state-personal`. Web login token rotated normally;
  the current private login link is in `console/access-url.txt`, not this record.
- Two sequential real CPU Docker commands completed and appear in the experiment comparison.
  Each used at most 1 CPU / 256 MiB, a 60-second timeout, no network, GPU or model. They retain
  21 metric points each, source/image evidence, readable results and released leases.
- Strengthened the review browser smoke to assert actual baseline curves, not only configuration
  headers and metric cards. A first one-off deployment assertion confused metric-card count with
  experiment count; checking one loss card containing both experiment curves passes.

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
| Hosted foundation and reviewed PR integration | PR #10, cleanup `925247e` | passed | GitHub run `36678942535`; merge `682aad3`. No admin bypass or independent human review is claimed. |
| Stopped-writer backup, file verification and SQLite integrity | old deployment `920ee1d` | passed | 9,968 files; 26 databases; archive 403,701,760 bytes. SHA-256 verified and all copied databases report `integrity_check=ok`. |
| Lease drain and process identity audit | before upgrade | passed | 66 finished executions (1 personal + 65 benchmark), 65 released native leases, no pending executions. Unrelated live and old stopped containers preserved. |
| Production Controller/Web startup and schema migration | deployed `682aad3` | passed | Ready on 8766/8765, personal Projects v4→v6 on actual command registration; new node ledger v2; old benchmark stores remain unchanged. |
| Two CLI→HTTP→Docker→Records command runs | deployed `682aad3` | passed | Runs `35b8f3061a5644e884e39b578e0f30b4`, `4dac23198eae4507a2b47103ecd60264`; completed, 21 loss points each, code/image/outputs readable, cleanup confirmed and leases released. |
| Historical first-study and ASI reads/hash comparison | deployed `682aad3` | passed | First-study retains 48 events/2 artifacts. All 60 ASI artifact manifests readable; 9,844 original benchmark files have unchanged hashes, including scores and state. |
| Production Chromium acceptance | deployed `682aad3` | passed | Actual Docker metric comparison with two curves, responsive layout, old execution navigation and original ASI 60-run workbench. No fixture replaces production data in this check. |
| Strengthened comparison browser smoke | final evidence branch | passed | Fixture browser confirms baseline polylines for both metrics; no model or Docker execution. |

Backup: `/disk/disk_20T/wangxuehai/infra-backups/python-upgrade-20260930-143810/` (private).
`manifest.json` contains source paths, checksums, schema versions and pre-upgrade facts;
`state.tar` includes personal state, benchmark results, first-study workspace, host lock metadata
and the old built Web. `old-code.tar` preserves the exact old source. `evidence/` contains the
validation logs, concise JSON checks and screenshots; temporary `/tmp` copies are not the only evidence.

The retained smoke project is `/disk/disk_20T/wangxuehai/research/infra-upgrade-smoke-20260930`,
ID `18569f9b-3924-4b99-9577-1c504dd79e37`; it is explicitly deterministic plumbing evidence.
Production PIDs/log paths and startup arguments are stored privately in `state/services/deployment.json`.

## Open items and blockers

- None within the cleanup, review/integration and local upgrade acceptance scope.
- GitHub branch-protection API returns HTTP 403 for the private repository's plan; do not claim
  enforced protection. Hosted checks were inspected and passed before the authorized PR merge.

## Next steps

- None for implementation and deployment. Publish this final evidence through the follow-up PR;
  GPU/model/multi-node acceptance remains outside this task and is listed in project status.

## Compatibility and rollback

- The initial audit was read-only. The subsequent authorized upgrade added two labeled smoke Runs
  and migrated personal Projects; original first-study/benchmark results remain intact.
- Removed internal implementation names are not public SDK exports; external code importing
  `LocalProjectCatalog` or `CodexBindingStore` directly should use the project-owned catalog and
  `SessionBindingStore`. Persisted schemas and command names are not removed by this cleanup.
- Projects v6 and lease v2 require the verified pre-upgrade state backup for downgrade; the code tag
  alone is insufficient. Follow the linked runbook: stop new work, preserve post-upgrade results,
  restore the old source/state at their original paths, and rebuild old dependencies/assets.
- The node ledger did not exist before this upgrade; it now has two released smoke leases. On
  downgrade, preserve it separately after draining, rather than leaving two independent schedulers.
