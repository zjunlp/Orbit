# Batch adapter external entrypoint contract
branch: feat/benchmark-expansion · status: completed · updated: 2026-11-16

## Goal

Make external methods usable in LegalBench, LawBench and MMAU through the real Orbit contracts.

## Changes

The shared batch planner assigned the string-valued `Method.entrypoint` directly to the
array-valued Run command. Empty/reference calibration never exercised this branch, and the MMAU
fixture incorrectly used an array. Split command strings with POSIX quoting into argv, reject
empty executables, and document that shell expansion requires an explicit shell command.
Correct the fixture and check all three planners against the actual Method and Run schemas.
Native grading and task inputs are unchanged.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Adapter regression tests | working tree over 5f39c49 | passed | Real Method/Run schemas for all three adapters; quoted arguments and empty executable handling; explicit synthetic fixtures. |
| Scripted external Docker check | working tree over 5f39c49 | passed | Four original tasks per adapter; quoted argv, configuration, hidden labels, audio reads and valid empty-answer grading; cleanup confirmed and leases released. Explicit protocol script, no model inference. |
| `pnpm verify` | working tree over 5f39c49 | passed | Full format, lint, types, boundaries, tests and build; initial formatting failure corrected. |
| Real-model / full-suite evaluation | — | not_run | No subject profile or audio model configured; sampled protocol checks do not establish model compatibility or suite parity. |

## Next / open issues

Real-model and full-suite validation remain untested. CLI subject execution still needs its own
authenticated check. The additional external-process checks establish the sampled command/data/
grading path, not model behavior or API compatibility.
