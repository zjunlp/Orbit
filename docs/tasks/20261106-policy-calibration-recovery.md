# Policy calibration recovery and cleanup
branch: feat/embodied-eval · status: completed · updated: 2026-11-06

## Goal

Close the submission/linkage crash window and prevent policy acceptance while an earlier verifier
still holds resources. Reuse existing Run ownership tags, history, stop intent and cleanup events.

## Changes

Policy cancellation enumerates owned persisted Runs as well as Trial references, including unlinked
solve and verification submissions. Reports and automatic completion require terminal, cleaned Runs
and released leases across scoring history and unlinked submissions. Cleanup events resume waiting
calibration completion, including Runs that have no Trial link. Ordinary batch cancellation retains
its evidence-verification behavior.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Focused lifecycle regressions | working tree | passed | 64 tests; explicit synthetic adapter/Run replies, including both interrupted linkage phases, unrelated-job isolation and pending/failed historical cleanup recovery |
| `pnpm verify` | working tree | passed | 740 tests passed, 26 existing skips; format, lint, types, boundaries and builds passed |
| Real Docker interrupted linkage | working tree | passed | Active unlinked batch/service, original context stopped, expired stop intent set before recovery; cancelled Run cleaned and lease released |
| Real Docker historical verifier cleanup | working tree | passed | Original verifier container held with active lease after selected rescore; report stays incomplete, then completes on cleanup; all owning containers, networks, volumes and leases audited |
| Initial real Docker fixture timing | working tree | failed | Default 30-second health interval exceeded harness wait; corrected synthetic fixture to a 1-second health check and reran successfully; original failure retained locally |

## Next / open issues

Both real Docker checks use explicit synthetic CPU model/adapter fixtures and real resource lifecycle;
they make no model-inference claim. Full-suite model evaluation is outside this lifecycle fix.
