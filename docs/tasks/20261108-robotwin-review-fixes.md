# RoboTwin sample rejection and CUDA build argument
branch: feat/embodied-eval · status: completed · updated: 2026-11-08

## Goal

Keep frozen RoboTwin batches running past expert-rejected samples and forward the requested CUDA architecture in the documented simulator build.

## Changes

- Record unstable expert scenes and failed expert checks as `sample_rejected` before the policy starts.
- Keep the rejected sample's evidence and continue the frozen batch. Unexpected reset errors still stop the batch.
- Forward `CUDA_ARCH` to the simulator build with the default of `8.0`.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| pnpm verify | working tree | passed | Includes Python and TypeScript failure-kind parity. |
| Python SDK | working tree | passed | 73 tests each on Python 3.8 and 3.11. Covers continuation, evidence and unexpected reset errors. |
| Documented build arguments | working tree | passed | Shell check of the default and an explicit architecture override. |
| Real mixed batch | working tree | passed | An expert-rejected scene between two accepted scenes preserved both rollouts in one solve Run. CPU verification and rescore kept the rejection and left it out of the score denominator. Run cleanup and lease release passed. |

## Next / open issues

- Calibration uses expert-accepted seeds because it requires a valid result for every planned sample.
