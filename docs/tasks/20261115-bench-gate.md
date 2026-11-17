# Evolution gate API and calibration (E3/E6)
branch: feat/run-trajectory · status: completed · updated: 2026-11-15

## Goal
Expose frozen-policy gate verdicts through the daemon, clients and CLI, and calibrate the complete path.

## Changes
- Bounded YAML/task-file input, explicit report disambiguation, typed API/clients and distinct CLI exit codes.
- Immutable policy/evidence/verdict documents in the existing store; retained assessment history and replay after source deletion.
- Separate A/A mode for independent runs of identical content, with no promotion level.
- Reproducible real-CLI development tasks, independent verifier and task-paired centered bootstrap tool.
- Updated design, guides, status and implementation plan; no Web version-chain UI in this package.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| pnpm verify | E3/E6 working tree | passed | Format, lint, types, boundaries, 1,063 tests and build; 28 opt-in integration tests skipped |
| Store/API/CLI integration | E3/E6 working tree | passed | Real SQLite/handlers/client; synthetic report scores, paused execution; immutability, deletion, ambiguity, history, migration and final-Agent selection |
| Real Codex A/A | E3/E6 working tree | passed | Two independent executions per development task; identical configuration, actual model replies/usage and independent offline verifier; improvement inconclusive |
| Real destructive bundle | E3/E6 working tree | passed | Actual Codex responses to damaged instructions; valid verification and demonstrated performance-loss rejection |
| Real daemon/CLI and replay | E3/E6 working tree | passed | Explicit reports, exits 3/2, persisted show/list after restart, saved-evidence replay; cleanup complete and leases released |
| Resampling | E3/E6 working tree | passed | 5,000 fixed-seed task-paired centered bootstrap draws; degenerate A/A distribution explicitly reported |
| Stale CLI and leakage | E3/E6 working tree | passed | Controlled metadata/API fixtures; stale conditions request parent rerun, informedBy tasks excluded; no second CLI launch claimed |
| Further Claude checks | — | not_run | User requested no further Claude testing |
| Full benchmark / adaptive reuse calibration | — | not_run | V0/V4; bounded development checks do not establish benchmark-wide power or adaptive guarantees |

## Next / open issues
- Next: V0 pilot sizing, E4 flow helpers, V1 reference evolver; E5/T6 provide the Web presentation.
- Keep assessment history: jobs deleted before any verdict captured them cannot be recovered.
- Policy precommitment remains user-declared; a saved policy hash alone does not prove it preceded results.
- Initial real-check startup/auth failures were resolved with the existing native CLI runtime and current login before validation; no fake execution substituted.
