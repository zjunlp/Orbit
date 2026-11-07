# Preserve shared GPU memory budgets
branch: feat/embodied-eval · status: completed · updated: 2026-11-06

## Goal

Keep model and simulator GPU capacity requirements when they share one leased GPU.

## Changes

- Preserve GR00T's model memory budget in both sharing modes. Declare the simulator budget separately,
  with a configurable default; CPU simulators do not declare a GPU budget.
- Add each explicit shared service budget to its GPU owner through the existing role planner, without
  extra GPUs or mutation of frozen specs. Already folded Compose budgets are not counted twice.
- Check capacities per role during admission. Reject hardware that cannot fit the requirements;
  wait when a fitting device is busy or leased, without falling back to an undersized GPU.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Regression before fix | b3edd5c + tests | passed | Six failing cases reproduce dropped shared budgets and incorrect per-role capacity admission |
| Production configuration to allocator | working tree | passed | Synthetic audited assets; both sharing modes, heterogeneous GPU capacities, shared owners, busy/leased cards, multi-card roles and Compose folding |
| Python SDK 3.8 / 3.11 | working tree | passed | 46 checks each; four model/benchmark resource combinations and simulator budget validation |
| pnpm verify | working tree | passed | 704 tests passed; 26 existing skips; lint/types/boundaries/build passed |
| Real GPU resource lifecycle | working tree | passed | Capacity failures rejected through HTTP preflight and submit; main and shared service see one matching leased device; cleanup done and lease released; no model inference |

## Next / open issues

Memory budgets are admission estimates rather than measured peak guarantees; full model/simulator
statistical parity remains outside this fix.
