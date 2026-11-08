# Joint GPU admission and shared GPU memory budgets
branch: feat/embodied-eval · status: completed · updated: 2026-11-07

## Goal
Admit only requests whose roles can simultaneously get distinct qualifying GPUs, and keep model and simulator memory requirements when they share one leased GPU.

## Changes
- Capacity admission reuses the allocator's GPU candidate filtering and joint matching. Admission considers all probed cards; allocation excludes busy and leased cards. Shared GPU consumers fold into their owner; independent roles keep separate requirements.
- GR00T keeps its model memory budget in both sharing modes. The simulator budget is declared separately with a configurable default; CPU simulators declare none.
- Each explicit shared service budget is added to its GPU owner through the existing role planner, without extra GPUs or mutating frozen specs; already folded Compose budgets are not counted twice.
- Capacities are checked per role. Hardware that cannot fit is rejected; when a fitting device is busy or leased the request waits, with no fallback to an undersized GPU.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Joint-admission regressions before fix | 74fb1e6 + tests | passed | Seven failing checks reproduced impossible role overlap and inconsistent legacy model filtering |
| Shared-budget regressions before fix | b3edd5c + tests | passed | Six failing cases reproduced dropped shared budgets and wrong per-role admission |
| Targeted resource tests | working tree | passed | 77 tests: GPU roles/sharing, allocation, devices, cluster placement, overlapping memory/model/ID/multi-card requirements, reassignment |
| Production configuration to allocator | working tree | passed | Synthetic audited assets; both sharing modes, heterogeneous capacities, busy/leased cards, multi-card roles, Compose folding |
| Python 3.8 / 3.11 SDK | working tree | passed | 46 checks each; four model/benchmark resource combinations, simulator budget validation |
| `pnpm verify` | working tree | passed | Latest: 713 tests, 26 existing skips; lint/types/boundaries/build |
| Real GPU / HTTP lifecycle | working tree | passed | Overlapping roles and capacity failures rejected by preflight and submit; fitting cards admitted despite occupation; leased-card queue/cancel; main and shared service see one leased device; cleanup and release; no model inference |

## Next / open issues
Memory budgets are admission estimates, not measured peak guarantees. Graphics capabilities remain declarations rather than verified hardware features.
