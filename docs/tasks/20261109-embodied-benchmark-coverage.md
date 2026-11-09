# Native embodied benchmark coverage

branch: feat/embodied-eval · status: completed · updated: 2026-11-09

## Goal

Expand the fixed native task catalogs and evaluation protocols for the existing embodied benchmarks.

## Changes

- Register the pinned RoboCasa365 full dataset catalog, the four Lifelong phases and their cumulative scopes.
- Register native ManiSkill3 tabletop tasks by robot and controller. Keep the RLinf Plate-25 recipe separate.
- Support the RT-1/Octo policy termination output on SimplerEnv fixed grids and verify its effect on subtask progression.
- Register RoboTwin Randomized Cartesian and allow independent registration of the CALVIN scene D benchmark.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Workspace and SDK checks | working tree | passed | `pnpm verify` on Node 24.22.2 and 98 SDK tests each on Python 3.8 and 3.11. |
| LIBERO Spatial | working tree | passed | All ten tasks reset, settled, rendered both cameras and executed a native control step. |
| RoboCasa365 task scopes | working tree | passed | The two pinned runtime catalogs agree. The CLI lists the 317-task catalog and the individual and cumulative Lifelong scopes. A single-state sample plan covers all 317 task IDs. |
| RoboCasa365 1.0.1 full catalog | working tree | passed | All 317 tasks reset, rendered and executed a native control step in pretraining scenes. DrinkwareConsolidation required recovering the observation after its native reset opened the cabinet. |
| GR00T N1.5 on RoboCasa365 Composite-Seen and Composite-Unseen | working tree | passed | One frozen episode per group ran in one real model batch under the target50 pretraining-scene profile. Both passed independent CPU verification and selected rescore. |
| ManiSkill3 tabletop | working tree | passed | Eighteen tasks reset, rendered and executed a native step. The CLI lists the same eighteen tasks across nine available profiles after splitting the goal-conditioned tasks. |
| ManiSkill3 hidden targets | working tree | passed | In five native tasks, changing only the target changed the bound `goal_pos` while leaving the other policy inputs equal. A scripted PickCube episode received the native goal on every call and verified on CPU. |
| ManiSkill3 asset-backed profiles | working tree | not_run | AssemblingKits and TurnFaucet require official assets from an unreachable server. |
| SimplerEnv policy termination | working tree | passed | A scripted policy exercised early advance and final stopping on both Google grids and final stopping on WidowX Visual Matching. CPU evidence checks passed. Google runs used the denoiser-off profile. |
| X-VLA on RoboTwin Randomized Cartesian | working tree | passed | Two expert-accepted tasks ran with the task-name instructions and passed independent CPU verification, selected rescore and cleanup. |
| CALVIN benchmark-only | working tree | passed | Generated a weight-independent registration and expanded all 1,000 frozen sequences with the existing scene D identity. |
| Full-suite statistical comparison | working tree | not_run | Scope is native catalog checks and bounded integration runs. |

## Next / open issues

- ManiSkill3 upstream PickClutterYCB has a constant false success predicate and is excluded from scored tabletop profiles.
