# ASI native verification budgets
branch: fix/asi-verify-budgets · status: completed · updated: 2026-10-09

## Goal
Allow ASI TSP/Max3SAT graders to finish their prescribed solver execution.

## Changes
- The previous fixed 30-minute verifier limit interrupted TSP's 3600-second
  solver and left no startup/collection margin for Max3SAT's 1800 seconds.
- Pass the trial task to the built-in verifier and use outer limits of 90/60
  minutes respectively. Other tasks stay at 30 minutes; native commands and
  CPU, memory, GPU requests are unchanged.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Existing ASI tests | b3782e8 | passed | 14 tests |
| Reproduction | before fix | passed | Both long tasks incorrectly returned 30 minutes |
| `pnpm verify` | this branch | passed | 192 tests; 10 opt-in tests skipped; lint/types/boundaries/build passed |
| Built CLI adapter protocol | this branch | passed | Saved-run metadata produces 90/60/30-minute specs, unchanged 1 CPU/4 GiB/0 GPU |

## Next / open issues
The outer limits include startup and collection time; native solver budgets remain unchanged.
