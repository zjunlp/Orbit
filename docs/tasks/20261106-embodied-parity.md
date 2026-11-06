# OpenPI LIBERO sampled reference parity
branch: feat/embodied-eval · status: completed · updated: 2026-11-06

## Goal

Compare the pinned official evaluation with Orbit under identical declared conditions. Check
deterministic processing, fixed-action environments and an aligned real VLA rollout separately.
The scope is sampled protocol parity; full-suite statistical equivalence remains separate.

## Changes

- Preserve the official evaluation function and instrument its environment/client boundaries.
  Stop after the completed first episode, preserving its task, initial-state and random-stream prefix.
- Freeze the comparison plan and implementation/source fingerprints before reference execution.
  Reuse existing Orbit Runs, model services and resource leases for the checks.
- Keep raw outputs, local configurations and per-run results outside the source repository.
- Keep independent-process bitwise comparison and shared-compiled-runtime protocol control as
  separate verdicts. The latter uses real inference on two independently initialized key-0 streams;
  it does not relax tolerances or replace either path's actions.
- Serialize native NumPy scalar counters without changing the official numerator/denominator.
  Retain failed recorder/comparison attempts and link the control plan to the original criteria.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Deterministic preprocessing and native fixed actions | working tree | passed | Exact dtype/shape/values, full simulator-state and raw camera fingerprints; two initial states |
| Native horizon negative | working tree | passed | Explicit zero fixture, official loop and SDK driver; complete horizon and denominator agree |
| Independent GPU process bitwise rollout | working tree | failed | Both paths complete successfully, but full predicted chunks differ; preserve this result separately |
| Shared-runtime real VLA protocol control | working tree | passed | Same compiled model, fresh independent key-0 streams; all live inputs/full predicted chunks and native trace agree exactly |
| Official-path cross-process repeatability | working tree | failed | Repeated official paths receive identical first image/state inputs but produce different first action chunks; specific low-level cause remains unisolated |
| Python 3.8 / 3.11 SDK/tool checks | working tree | passed | 21 checks each, including the NumPy-counter regression and explicit synthetic stream-isolation test |
| `pnpm verify` | working tree | passed | Lint/types/boundaries, 5 script + 598 Orbit + 69 Web tests and builds; 26 existing skips |

## Next / open issues

Sampled protocol comparison is complete under the declared OSMesa/shared-compiled-model control.
Independent GPU process bitwise repeatability is not established; a passing control does not erase
that failed check. Full-suite statistical equivalence and later-episode stream parity remain untested.
This adds validation tools, not production model pooling/shared batches or a global catalog fidelity claim.
