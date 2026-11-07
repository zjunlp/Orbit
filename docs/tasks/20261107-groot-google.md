# GR00T N1.7 and native SimplerEnv Google Robot
branch: feat/embodied-eval · status: completed · updated: 2026-11-07

## Goal
Reuse the GR00T connector and native Gym driver for the official Fractal checkpoint and Google Robot tasks.

## Changes
- Pin the six-task Google catalog, rectangular camera, quaternion state, controller and sticky gripper semantics.
- Extend independent registration and selected inference-asset provisioning; reuse existing runtimes and backbone assets.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| pnpm verify / final check | working tree | passed | Format, lint, types, boundaries, 753 tests, 26 existing skips and builds |
| Python SDK | working tree | passed | 59 checks each on Python 3.8 and 3.11, including Google transport, configuration and selected asset downloads |
| Native environment checks | working tree | passed | All six tasks initialized and stepped; official image/quaternion/sticky-gripper checks and direct native fixed-action comparisons |
| Real bounded policy calibration | working tree | passed | Official Fractal checkpoint, shared model load, representative native tasks, per-episode CPU verification, selected rescore, GPU placement and cleanup |

## Next / open issues
- Full-suite performance, statistical equivalence and independent GPU-process bitwise parity remain unverified.
