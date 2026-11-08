# RLinf OpenVLA-OFT on native LIBERO-90
branch: feat/embodied-eval · status: completed · updated: 2026-11-08

## Goal

Validate a released LIBERO-90 checkpoint with Orbit's native OFT recipe and two frozen samples.

## Changes

- Register the pinned RLinf checkpoint and its normalization key with the independent OFT policy service.
- Use single-camera observations, the discrete action-token decoder and the existing native action conversion.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Policy image build | working tree | passed | Reuses the pinned OFT dependencies. |
| Decode smoke check | working tree | passed | Released tokenizer and image processor with a synthetic actor. |
| Frozen reference metadata | working tree | passed | The RLinf recipe records its single-camera input, sampling temperature and service seed. A regression test checks the RLinf and continuous OFT descriptions. |
| Pinned RLinf decoder comparison | reviewed working tree | passed | With real weights, two fixed inputs and matched seeds produced identical action components in review. |
| Real policy calibration | working tree | passed | One model load for two frozen native tasks. Independent CPU verification, selected rescore, budget and cleanup checks passed. |
| Saved timeline | working tree | passed | Each camera recording matched the control steps and was available with the trajectory in Web. |
