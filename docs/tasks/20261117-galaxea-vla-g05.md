# GalaxeaVLA G0.5 on RoboTwin 2.0

branch: feat/embodied-eval · status: completed · updated: 2026-11-17

## Goal

Evaluate the released LeRobot conversion of GalaxeaVLA G0.5 on native RoboTwin 2.0.

## Changes

- Add the [pinned policy image and asset registration](../../examples/bench-adapters/embodied/policies/galaxea-vla-g05/README.md).
  Preserve native CHW uint8 camera inputs for resize and use the packaged processors, including timestep-specific action normalization.
  Reject malformed raw prediction shapes before normalization can broadcast them and retain the raw rejected actions.
- Register native joint-control Clean and Randomized suites at the release's eight-control cadence.
  Refresh native observations after each control and maintain the upstream lighting sequence.
  Guard the release registration with the published checkpoint, backbone, and normalization digests.
  Preserve native stopping, cameras and task scoring. The evaluation option `gpuId` pins the
  shared simulator and policy device.

## Validation

| Check | Result | Notes |
| --- | --- | --- |
| Image and release assets | passed | Built the pinned image and verified the public model file against its published SHA-256. |
| Semantic binding | passed | Rejects swapped camera identities and reordered joint targets. |
| Inference wrapper regression | passed | Synthetic predictions check full-horizon postprocessing, chunk length, episode resets, and rejected configuration and action shapes. |
| Released processors | passed | Non-uniform RGB frames match the native uint8 resize path for all three cameras. CPU regressions also cover queued processing after reset and rejection of truncated predictions. |
| Randomized observation schedule | passed | The G0.5 runner refreshes native rendering on every control in a synthetic lighting counter test. |
| Native suite registration | passed | Clean and Randomized each expose the 50 original tasks. |
| Real-policy rollout and CPU verification | passed | The Clean and Randomized nine-control `adjust_bottle` checks each produced two action chunks. The Randomized sample used per-observation lighting. CPU Verify and Score agreed with the native outcome. |
| Repository checks | passed | `pnpm verify` and the embodied SDK tests passed. |
| Full-suite evaluation | not_run | Sampled development validation. |

## Next / open issues

Full-suite results and numerical equivalence with Galaxea's original evaluator remain unverified.
