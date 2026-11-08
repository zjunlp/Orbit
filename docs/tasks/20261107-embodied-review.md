# Review fixes after merging the embodied integration
branch: fix/embodied-review · status: completed · updated: 2026-11-07

## Goal
Fix the defects found when reviewing the merged `feat/embodied-eval` (main@4897fc3) and bring its
records back within the AGENTS.md rules.

## Changes
- Cancellation and restart: cancel stops solves persisted before Trial linkage; on restart the stop
  intent is restored from a snapshot of live solves before RunService schedules queued work. Pending
  Trials claim their unlinked solve (ordinary or batch) instead of solving again and keep cleanup
  pending until it is confirmed. A cancelled policy check writes `endedAt` only after cleanup.
- Batches split on the same effective budget (`executionBudget`) that comparison conditions record,
  and the partition is part of the conditions; batches are assigned in plan order.
- Episode deadline checked after every environment step; the contract records the budget and the
  verifier rejects valid results past it. Valid Gym failures may end at a native truncation.
- Accepted chunks keep raw model output next to converted actions; the named conversion is
  recomputed in verification. Evidence v2+ must carry the solve archive. Plans and batches reject
  samples aliasing one WidowX reset seed.
- Web compare lists tasks without a daemon pairing as "No paired result".
- Removed `legacyCalibrationEnd` (it only served jobs from intermediate branch builds); connector rules
  move from the shared contract to policy registration; one migration backup per source version with
  its path printed; GPU mode detected on first use and re-asked after a failed Docker query; plan
  order in reports and Trial navigation.
- SDK: shared WebSocket transport and LIBERO helpers, stdlib-only `file_digest`, verify containers
  without root, base images pinned by digest, Hub token kept off redirect hosts, daemon test threads.
- Records: 15 embodied task records consolidated into five, personal run history removed, design
  §9.4a reduced to decisions, status within 40 lines.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| New regressions fail on 4897fc3 | 4897fc3 + new tests | passed | Unlinked solve adoption, batch budget split, final-step deadline (synthetic Runs and endpoints) |
| `pnpm verify` | 82ed546 | passed | 5 script + 677 Orbit + 73 Web tests, 26 existing skips |
| Python SDK, all modules | 82ed546 | passed | 62 tests on Python 3.10 in a throwaway venv (numpy, websockets, msgpack, msgpack-numpy 0.4.8, pyzmq, PyPI openpi-client) |
| Real Docker / GPU embodied runs | — | not_run | No embodied images on this machine; verify-as-host-user and pinned base images unbuilt |
| Rebuild lock for transitive pip/apt packages | — | not_run | Needs `pip freeze` from the validated images; runtime stays pinned by image ID |

## Next / open issues
SDK files changed, so registered embodied benchmarks must be re-registered with the new
implementation digest. Solve containers still run as root because LIBERO writes its config under
`$HOME` at import.
