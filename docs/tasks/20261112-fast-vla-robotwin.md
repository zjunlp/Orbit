# Fast-VLA on native RoboTwin 2.0

branch: feat/embodied-eval · status: completed · updated: 2026-11-12

## Goal

Run the released Fast-VLA RoboTwin policy with native Clean and Randomized scenes and an independent CPU verifier.

## Changes

- Register the actor and its frozen DM0.5 and DINOv2 configuration as an offline Policy with immutable asset identities.
- Declare the Policy's observation and action semantics independently and validate the benchmark mapping before registration.
- Add a separate RoboTwin recipe that keeps the native fifty-control joint controller and supplies the head camera from 17 and 8 controls before each query.
- Match the upstream video-enabled frame schedule by refreshing the current observation at each replan boundary and recording each history frame at its control offset.
- Reset task memory per policy connection, including each episode in a fixed sequential solve batch.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| History regression | working tree | passed | Tests cover the extra frame at the replan boundary, history offsets with a reused image buffer, and reset behavior. |
| Native dynamic-light observation | working tree | passed | With dynamic lighting enabled on a frozen Randomized scene and the same fixed controls, Orbit and upstream matched the observation call sequence, light and random state, current RGB and history frames, and joint state at the next query. |
| Policy registration semantics | working tree | passed | The policy accepts the native recipe and rejects swapped history frames or an incompatible joint order under the same benchmark profile ID. |
| Clean and Randomized registration | working tree | passed | Both native 50-task catalogs and their simulator asset digests resolve. |
| Published reference and cache reset | working tree | passed | Both released action blocks matched within the upstream tolerance. The two successive policy connections exercised prefill, cache reuse and a fresh prefill. |
| Native Clean batch | working tree | passed | Two frozen `adjust_bottle` episodes succeeded in one solve process. Independent CPU verification and rescoring matched. |
| Native Randomized rollout | working tree | passed | One frozen `adjust_bottle` episode succeeded with the corrected frame schedule. Independent CPU verification and rescoring matched. |

## Next / open issues

- Full-suite model evaluation remains open for both scene presets.
