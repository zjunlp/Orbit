# Policy acceptance execution and cleanup completion
branch: feat/embodied-eval · status: completed · updated: 2026-11-06

## Goal

Keep the budget active through automatic rescore planning, while allowing cleanup to finish after
on-time execution without changing its budget result.

## Changes

Separate the frozen execution completion timestamp from final cleanup completion on the existing
BenchJob. Completion callbacks recheck open Trials and owned Runs; duplicate callbacks cannot finish
a rescore still being planned. Deadline enforcement reconciles completed execution from actual
Trial/Run end times before stopping unfinished work. The original budget remains fixed across
restart and explicit later CPU rescore. CLI/Web show execution finished while cleanup is pending;
the final report requires confirmed cleanup and a published final completion time.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Focused lifecycle checks | working tree | passed | 70 tests; explicit synthetic replies; planning expiry, old premature completion markers, cleanup-only deadline crossing, restart and later manual rescore |
| `pnpm verify` | working tree | passed | 747 tests passed, 26 existing skips; format, lint, types, boundaries and builds passed; CLI/Web contract and cleanup-stage checks included |
| Real Docker planning deadline | working tree | passed | 45-second budget remains active during held automatic rescore planning; deadline stops work, late plan cannot launch another verifier; all owning resources and leases cleared |
| Real Docker cleanup-only deadline crossing | working tree | passed | Original verifier retained in scoring history with an active lease; on-time execution timestamp remains fixed past the deadline, report waits for cleanup and then passes; no budget failure added |

## Next / open issues

Both real Docker checks use synthetic CPU model/adapter fixtures, real containers and leases, and
final resource audits. No model inference or full-suite model evaluation is claimed by these checks.
