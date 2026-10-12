# Append completed benchmark tasks
branch: fix/record-privacy-sync · status: completed · updated: 2026-10-12

## Goal
Append completed tasks to an existing benchmark job through the daemon API, keeping invalid results and original artifacts.

## Changes
- Opt-in task append for consolidation, exposed in contracts, client, CLI and Web.
- Preserve original trials, imported validity, run IDs, artifacts, auth and source benchmark tags; reject duplicate task slots and pruning during append.
- Repository records retain reusable technical content; personal usage notes belong outside the source checkout (AGENTS.md and design §3).
- Explicit transport-alias compatibility: same benchmark path/config/source and method/credential; only proxy and host-network differences allowed.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Targeted API/store tests | working tree | passed | 6 tests; real HTTP/store/filesystem, explicit terminal fixtures |
| pnpm verify | integration working tree | passed | 192 Orbit + 11 Web + 5 script tests; 10 opt-in tests skipped; types, boundaries and build passed |
| pnpm smoke:package | integration working tree | passed | Isolated package install, CLI/npx, exports/types, disposable daemon HTTP, Web/assets and 8 real doctor checks |
| Source parity and record review | integration working tree | passed | Runtime, tests and tooling match the existing local implementation; repository notes retain only reusable technical content |
| GPU/model benchmark rerun | integration working tree | not_run | No new executor or Agent CLI behavior; append uses explicit terminal fixtures with real HTTP/store/filesystem |

## Next / open issues
- Registrations are current settings, not immutable submit-time snapshots; callers must verify benchmark content identity.
