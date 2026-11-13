# SimplerEnv native catalogs and evaluation settings

branch: feat/embodied-eval · status: completed · updated: 2026-11-08

## Goal

Expose the pinned native SimplerEnv task catalog and the published Visual Matching and Variant
Aggregation scene sweeps as benchmark registrations independent of policy weights.

## Changes

- Enumerate the 21 Google Robot and 7 WidowX prepackaged tasks from the pinned fork.
- Freeze the scene, rendering, robot and object pose grids from the RT-1 and Octo evaluation
  scripts. Use task-specific native horizons and pass reset coordinates to ManiSkill2.
- Let the sample planner enumerate every fixed grid point. Keep the grid index and RNG seed
  independent while retaining the existing seed-sum identity for prepackaged environments.
- Retain the established policy binding and native success signal. Reject blank raw RT frames
  even with an overlay and allow a separate profile with OptiX denoising disabled. Document the
  [benchmark-only configuration](../../examples/bench-adapters/embodied/benchmarks/simpler-env/README.md).

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Native source and Orbit catalog | working tree | passed | Five benchmark-only registrations against pinned source and image. The fixed catalogs expose 1,164 Google Visual Matching, 1,992 Google Variant Aggregation and 96 WidowX Visual Matching grid points. |
| Sample planning and SDK regressions | working tree | passed | The CLI expands all 600 Move Near Variant Aggregation points. Targeted Python 3.8 and 3.11 checks cover bounds, seed aliasing and the existing adapter. |
| Native reset and control | working tree | passed | 141 checks covering every task ID and representative camera, material, lighting, scene and robot-pose settings. The RT renderer check is separate. |
| Default RT renderer | working tree | failed | The native Google Visual Matching top-drawer camera returned blank raw RGB on an OptiX error. The adapter rejects this condition before policy inference. |
| Explicit RT renderer variant | working tree | passed | All 87 representative RT settings passed raw camera validation, native reset and control. A Google drawer and both WidowX 3 Hz drawers repeated the same frozen native reset poses. |
| Native horizons and evidence | working tree | passed | A scripted policy fixture completed a native 80-control Google Variant Aggregation episode and a 60-control WidowX Visual Matching episode. Independent CPU verification reproduced both negative verdicts. |
| New policy calibrations and full-suite statistical comparison | working tree | not_run | Validation scope is benchmark coverage, with policy integration recorded separately. |

## Next / open issues

- The paper's RT-1 and Octo action protocol can signal subtask termination. The existing 7-D GR00T
  binding uses the pinned simulator's timed drawer-subtask progression.
