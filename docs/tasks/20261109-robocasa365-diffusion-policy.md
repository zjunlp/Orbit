# Diffusion Policy on native RoboCasa365 Atomic-Seen

branch: feat/embodied-eval · status: completed · updated: 2026-11-09

## Goal

Run the published RoboCasa365 Diffusion Policy through Orbit's native Atomic-Seen benchmark.

## Changes

- Serve the published EMA model with its embedded normalization and a pinned offline CLIP text
  encoder. Use the existing `policy-ws` transport and independent read-only weight registration.
- Reuse the RoboCasa 1.0.0 environment. Send two observations and execute eight native actions
  per prediction. Apply the upstream single-environment stop check and maximum sparse-reward
  verdict. Freeze independent first resets for the Orbit sample plan.
- Record native `done` per control step in new runs. CPU verification checks the fixed action
  schedule, sparse reward, and exact stop point. Legacy evidence can be rescored with
  `diffusionStoppingVerified: false` in its verification record.
- [Setup and protocol](../../examples/bench-adapters/embodied/benchmarks/robocasa365/README.md#diffusion-policy)

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Workspace and SDK | working tree | passed | `pnpm verify` and 99 SDK tests on each of Python 3.8 and 3.11. The original RoboCasa registration digests are covered by the SDK tests. |
| Offline model I/O | working tree | passed | The published checkpoint loaded strictly, its normalization matched, the CLIP embedding had 768 values, and real CUDA inference returned a finite eight-step chunk. RGB preparation matched applying the upstream frame helper separately to each frame. |
| Native catalog and real policy batch | working tree | passed | Orbit listed all 18 Atomic-Seen tasks. Two frozen episodes exercised stopping at the horizon and stopping after success. Both passed independent CPU verification. Selected evidence-only rescore and container and lease cleanup passed. |
| Stop evidence regression | working tree | passed | A fixed-action replay in the native simulator passed strict CPU verification. Truncated success and failure traces were rejected. A saved legacy episode passed score verification with the stop check marked unavailable. `pnpm verify` and 101 SDK tests on each of Python 3.8 and 3.11 passed. |

## Next / open issues

- Full-suite scores and equivalence with the upstream parallel runner remain unverified.
