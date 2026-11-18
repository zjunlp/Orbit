# GalaxeaVLA G0.5 on RoboTwin 2.0

branch: feat/embodied-eval · status: completed · updated: 2026-11-17

## Goal

Evaluate the released LeRobot conversion of GalaxeaVLA G0.5 on native RoboTwin 2.0.

## Changes

- Add the [pinned policy image and asset registration](../../examples/bench-adapters/embodied/policies/galaxea-vla-g05/README.md).
  Use the packaged input and output processors, including timestep-specific action normalization.
  Reject malformed raw prediction shapes before normalization can broadcast them and retain the raw rejected actions.
- Register native joint-control Clean and Randomized suites at the release's eight-control cadence.
  Preserve native stopping, cameras and task scoring. The evaluation option `gpuId` pins the
  shared simulator and policy device.

## Validation

| Check | Result | Notes |
| --- | --- | --- |
| Image and release assets | passed | Built the pinned image and verified the public model file against its published SHA-256. |
| Semantic binding | passed | Rejects swapped camera identities and reordered joint targets. |
| Inference wrapper regression | passed | Synthetic predictions check full-horizon postprocessing, chunk length, episode resets, and rejected configuration and action shapes. |
| Released processors | passed | Opt-in CPU regressions check that full-horizon and queued processing agree after reset, and that a single-step prediction is rejected before normalization can broadcast it. |
| Native suite registration | passed | Clean and Randomized each expose the 50 original tasks. |
| Real-policy rollout and CPU verification | passed | Repeated the nine-control Clean `adjust_bottle` check with the rebuilt image. Both action chunks matched the prior run exactly, and CPU Verify and Score agreed with the native outcome. |
| Repository checks | passed | `pnpm verify` and the embodied SDK tests passed. |
| Full-suite evaluation | not_run | Sampled development validation. |

## Next / open issues

Full-suite results and numerical equivalence with Galaxea's original evaluator remain unverified.
