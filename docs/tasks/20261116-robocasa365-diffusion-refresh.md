# RoboCasa365 Diffusion Policy horizon update

branch: feat/embodied-eval · status: completed · updated: 2026-11-16

## Goal

Align the RoboCasa365 Diffusion Policy horizon with upstream.

## Changes

Pair the evaluator at `4121269` with the RoboCasa365 1.0.1 task registry and read the
native horizon directly. All 317 per-task budgets match the previous evaluator's scaled
values. Regenerate registrations and sample plans for the updated recipe.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Native catalog | working tree | passed | The new simulator registered all 317 tasks with the same horizons as the upstream 1.0.1 registry. A saved episode from the previous protocol still passed CPU verification. |
| Frozen-action replay | working tree | passed | A frozen TurnOnMicrowave sample replayed saved policy actions, reproduced the successful stop at control 216 and passed CPU evidence verification. Validated the regenerated policy registration against the pinned source, image and checkpoint. |
| Repository and SDK regression | combined refresh | passed | `pnpm verify`, 74 Python 3.8 shared SDK checks, and 190 Python 3.11 checks including one skip. |

## Next / open issues

Real-policy inference in the refreshed environment remains unmeasured.
