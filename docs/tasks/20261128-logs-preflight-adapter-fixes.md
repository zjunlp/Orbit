# Log tail offset, auth hostNetwork preflight, and adapter after.passEnv hardening
branch: fix/logs-preflight-adapter-hardening · status: completed · updated: 2026-11-28

## Goal
Fix three high-priority regressions and boundary gaps found in codebase review:
1. Restore negative `offset` support on `GET /api/v1/runs/:id/logs` (required by Web Overview `LogPeek`, CLI `orbit logs --tail`, and Feishu `/show`) while rejecting non-safe integers.
2. Prevent `auth.hostNetwork: true` from mutating `RunSpec` past Zod validation when combined with `services` (which poisoned SQLite reads) or leaking primary host networking onto worker runs.
3. Prevent external benchmark adapters from injecting arbitrary daemon environment secrets via `after.passEnv` or defining an `after` phase on `verify` runs.

## Changes
- **Logs negative offset & callers**:
  - Added `signedNum()` in `packages/orbit/src/daemon/http.ts` and used it for `/runs/:id/logs?offset=` while keeping `limit`, `after`, and `timeout` non-negative via `num()`.
  - Validated positive safe integer `--tail` in `packages/orbit/src/cli/program.ts`, caught log-tail fetch errors in `packages/orbit/src/feishu/index.ts`, and rendered `tail.error` in `packages/web/src/pages/run/Overview.tsx`.
- **Auth `hostNetwork` validation & node scoping**:
  - Added `hostNetworkError()` in `packages/orbit/src/runs/preflight.ts`, stopped mutating `spec.hostNetwork` in `specError()`, enforced `hostNetwork` compatibility with `services` and `network: false` in `localBlocker()`, `RunService.schedule()`, and `receiveRemote()`, and rejected `services` on remote arrival in `packages/orbit/src/runs/remote.ts`.
  - Resolved local auth `hostNetwork: true` only when leasing locally in `packages/orbit/src/runs/service.ts` so primary settings do not leak to worker nodes.
- **Adapter `after.passEnv` & `verify` restriction**:
  - Rejected `after.passEnv` in `AdapterRunSpec` (`packages/orbit/src/contracts/adapter.ts`) and omitted `passEnv` from `RunDescription["after"]` (`packages/orbit/src/bench/adapter.ts`).
  - Validated `AdapterRunSpec` inside `toRunSpec()` and rejected `after` on `verify` runs in `packages/orbit/src/bench/protocol.ts`.
- **Tests & docs**:
  - Added/updated regression tests in `daemon.test.ts`, `security-cli.test.ts`, `feishu.test.ts`, `state-integrity.test.ts`, and `bench.test.ts`.
  - Updated `docs/design.md` and `docs/guides/bench-adapter.md`.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `node scripts/boundaries.ts` | working tree | passed | `packages/orbit/src` and `packages/web/src` boundary check passed |
| `stripTypeScriptTypes` (Node erasable TS check) | working tree | passed | All 15 modified `.ts` files parsed cleanly in strict `strip` mode |
| `pnpm verify` (Biome, tsc, vitest, build) | working tree | not_run | Windows checkout has Node `v22.23.3` (project requires `>=24.18.0 <25`) and no `node_modules` installed; run in Node 24 / Linux or CI before merging |
| Real Docker / GPU / Feishu checks | working tree | not_run | Not executed on this Windows host |

## Next / open issues
- Run full `pnpm verify` on a Node 24 / Linux environment (or CI) before merging the PR.
