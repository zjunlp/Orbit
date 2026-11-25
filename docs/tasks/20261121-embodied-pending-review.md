# vla-eval receipts and BEHAVIOR source registration

branch: feat/embodied-eval · status: completed · updated: 2026-11-21

## Goal

Address the independent review of the remaining vla-eval and BEHAVIOR changes.

## Changes

- LIBERO tasks with a same-suite instruction collision use native IDs (`4a6c27e`).
  New LIBERO Verify receipts include the digest of the aggregate they checked.
  Older receipts use the task identity already stored on their Verify Runs.
- Only LIBERO overrides task selection in its episode wrapper. Custom benchmarks
  keep their own constructor arguments and task selection.
- BEHAVIOR registration, Solve and Verify use the same launcher and pinned
  package paths. The source probe runs without a host file mount or GPU devices.
  It checks tracked content and the file Python resolves for the evaluator.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | working tree | passed | Three Vitest workers. Orbit 1,016 passed and 32 skipped. Web 163 passed. |
| Python 3.11 | working tree | passed | vla-eval 19 passed, embodied SDK 195 passed and 1 skipped, native adapters 79 passed and 6 skipped. |
| Python 3.8 | working tree | passed | vla-eval 19 passed. |
| LIBERO native task selection | working tree | passed | Independent check against all 130 pinned task descriptors with simulation stubbed. Same-suite and cross-suite Verify receipt swaps were rejected. |
| BEHAVIOR interpreter | working tree | passed | Real CPU Docker fixtures exercised nonroot registration, both Docker runtimes, and Solve/Verify import resolution. The probe refused changed source and an evaluator shadow package. |
| GPU rollout | working tree | not_run | These checks covered task identity, evidence and import resolution. |

## Open issues

The same-file download lock was withdrawn after the second review reproduced
new retry and interruption failures. The original download race remains open.
Checking the planned native ordinal for an existing unique-name LIBERO task
requires a frozen catalog identity and remains open.
