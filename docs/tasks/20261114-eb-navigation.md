# Native EB-Navigation with SeeNav-Agent and Qwen2.5-VL
branch: feat/embodied-eval · status: completed · updated: 2026-11-14

## Goal

Run all five public EB-Navigation subsets with matched local policy endpoints and the native
success rule. Use the same scenes, prompts, projected views and feedback for both checkpoints.

## Changes

- Freeze the 300 official episodes and the checksummed AI2-THOR 5.0.0 CloudRendering build.
- Use the released SeeNav environment, training-recipe projection helpers and planner. Both
  policies share greedy decoding and a seeded, per-episode fallback.
- Verify distance, native actions and stopping from saved evidence. Synchronize the raw
  first-person and overhead recordings with the existing Trial timeline.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Catalog | EmbodiedBench pinned release | passed | Five subsets of 60 episodes each. |
| Native scene resets | AI2-THOR 5.0.0 | passed | All 300 released episodes restore the start pose, contain the goal object and render both projected views. |
| Native reference | AI2-THOR 5.0.0 | passed | One frozen sample per subset using fixed actions. Per-step reward, distance, action validity and stop match the pinned upstream environment. Initial first-person images differ by at most two RGB levels between simulator starts. CPU evidence verification passes. |
| Repository and SDK | Working tree | passed | `pnpm verify`, the Python 3.11 suite and the documented Python 3.8 shared SDK checks. |
| SeeNav-Agent | SeeNav matched profile | passed | Two frozen samples completed in one batch. CPU verification and rescore agree. |
| Qwen2.5-VL-3B-Instruct | SeeNav matched profile | passed | Two matching frozen samples completed on the same policy runtime image, with CPU verification and rescore. |

## Next / open issues

Full-suite statistical equivalence remains outside the validation
reported here.
