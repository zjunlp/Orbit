# Meta-World 3.1.1 and MuJoCo 3.3.0

branch: feat/embodied-eval · status: completed · updated: 2026-11-16

## Goal

Update the native Meta-World MT50 runtime.

## Changes

Pin Meta-World 3.1.1 and its required MuJoCo 3.3.0. Freeze the package versions in the
new reference and regenerate sample plans for the seeded single-task MT50 recipe.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Native MT50 | working tree | passed | All 50 tasks passed native reset, RGB and control. One short seeded native comparison covered camera, state, reward and stopping. A fixed-action episode passed independent CPU verification. |
| Repository and SDK regression | combined refresh | passed | `pnpm verify`, 74 Python 3.8 shared SDK checks, and 190 Python 3.11 checks including one skip. |

## Next / open issues

Real-policy inference in the refreshed environment remains unmeasured.
