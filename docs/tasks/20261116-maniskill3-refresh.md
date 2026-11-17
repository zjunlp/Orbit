# ManiSkill 3.0.1 for tabletop tasks and Plate-25

branch: feat/embodied-eval · status: completed · updated: 2026-11-16

## Goal

Update the native ManiSkill3 tabletop and RLinf Plate-25 runtimes.

## Changes

Pin ManiSkill 3.0.1 for both recipes and regenerate their sample plans. The
Colosseum V2 base build uses its explicit ManiSkill 3.0.0b22 argument.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Native tabletop | working tree | passed | All 18 asset-ready tasks passed native reset, RGB and control on the GPU-rendered path. A scripted PickCube episode passed CPU evidence verification. |
| Native Plate-25 | working tree | passed | The RLinf task passed native GPU PhysX reset, RGB, one control and sparse reward checks. |
| Repository and SDK regression | combined refresh | passed | `pnpm verify`, 74 Python 3.8 shared SDK checks, and 190 Python 3.11 checks including one skip. |

## Next / open issues

`AssemblingKits-v1` and `TurnFaucet-v1` still need their official assets. Real-policy
inference in the refreshed environment remains unmeasured.
