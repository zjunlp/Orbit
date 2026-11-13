# Session token accounting
branch: feat/run-trajectory · status: completed · updated: 2026-11-13

## Goal
Complete T3 on the existing branch: derive Run token totals from ATIF and expose them in CLI,
resource usage, immutable reports and comparison views without affecting evaluation scores.

## Changes
- Nullable Run token fields, explicit session provenance and CLI-reported cost only.
- Root and embedded child totals, distinct solve-run aggregates including retries and failed runs;
  shared batches count once and missing usage has explicit coverage.
- Persistence and worker synchronization reuse the trajectory lifecycle; cached legacy trajectories
  backfill totals when read. Old immutable reports are not rewritten.
- CLI show/usage/report/compare and Web Run/report/compare surfaces display totals.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Accounting/lifecycle regressions | T3 working tree | passed | 20 tests; store and converters real, Docker/transport doubles explicit |
| Web rendering | T3 working tree | passed | 2 tests; mocked API data, server-rendered Run and comparison views |
| Real Codex CLI | T3 working tree | passed | Bounded container task; all reported token fields match CLI ending usage; rebuild stable, cleanup done, lease released |
| Real Claude CLI | T3 working tree | failed | Service rejected authentication before model usage; missing usage remains null |
| Further Claude checks | T3 working tree | not_run | User explicitly requested no further Claude testing |
| pnpm verify | T3 working tree | passed | 831 core + 133 Web + 5 script tests; 28 opt-in tests skipped; types, boundaries and builds passed |

## Next / open issues
- Successful Claude accounting remains unverified on this machine; further testing was stopped at the user’s request.
- T3 remains on this feature branch. Next evolution package: T4 environment references.
