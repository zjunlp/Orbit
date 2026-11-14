# Trajectory export (X1)
branch: feat/run-trajectory · status: completed · updated: 2026-11-14

## Goal
Export saved Agent trajectories for training and review using the existing ATIF lifecycle.

## Changes
- Integrate the remote embodied evaluation updates before implementing X1.
- Shared request/manifest/Chat contracts, daemon export route, typed clients and CLI.
- Run/trial/job selection, intersecting filters, attempt-aware scoring, configuration revisions and batch deduplication.
- ATIF media packages and untruncated root/subagent Chat JSONL, reasoning policy and license notice.
- Existing redaction followed by failing secret scans; media hashes, bounded reads and private staged publication.
- Reject partial shared-batch selection to preserve task splits. No changes to execution or scoring state.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Embodied merge: pnpm verify | ea8843d | passed | 854 core + 136 Web + 5 script tests; 28 opt-in skipped; isolated Python CI requirements installed |
| X1 targeted integration | X1 working tree | passed | 19 checks; real store/converters/files/handlers, explicit scheduler and worker transport doubles |
| pnpm verify | X1 working tree | passed | 873 core + 136 Web + 5 script tests; 28 opt-in skipped; format, lint, types, boundaries and builds passed |
| Real daemon/CLI export | X1 working tree | passed | Actual HTTP service, offline container with imported ATIF/PNG, both CLI formats, file hashes/tokens; cleanup and lease release confirmed; no model/GPU |
| Cross-machine export | X1 working tree | not_run | Worker routing covered by an explicit transport double; two-machine integration is outside this package |

## Next / open issues
- Next: E1 task-set freezing, followed by E2/E3 gate evaluation and E6 calibration.
- Remote media checks use an explicit worker transport double; no two-machine validation planned here.
- X2/X3, evolution gates and the unified step viewer are separate packages.
