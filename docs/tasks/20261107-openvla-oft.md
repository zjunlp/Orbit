# OpenVLA-OFT policy endpoint
branch: feat/embodied-eval · status: completed · updated: 2026-11-07

## Goal
Add the public OpenVLA-OFT LIBERO Spatial checkpoint as an independent policy, reusing native LIBERO and bounded policy calibration.

## Changes
- Pin official inference sources and assets; keep model preprocessing and action conversion in the policy endpoint.
- Reuse the native simulator, evidence, batch and CPU verification paths with an explicit OFT evaluation recipe.
- Provide portable download, image and registration instructions.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| pnpm verify | working tree | passed | Format, lint, types, boundaries, 753 tests and builds; 26 pre-existing skips |
| Python SDK | working tree | passed | 57 checks on Python 3.8 and 3.11, including synthetic OpenVLA transport and raw-action boundaries |
| Official deterministic I/O comparison | working tree | passed | Real model-image dependencies; official image/state and native-action helper values matched |
| Real bounded policy calibration | working tree | passed | Official merged checkpoint, shared model load, native LIBERO episodes, independent CPU verification, selected rescore and complete resource cleanup |

## Next / open issues
- Full official-runtime parity and full-suite statistical equivalence remain unverified.
