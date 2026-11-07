# Match GPU roles jointly during admission
branch: feat/embodied-eval · status: completed · updated: 2026-11-06

## Goal

Reject requests whose roles cannot simultaneously obtain distinct qualifying GPUs, instead of
admitting work that can never leave the queue.

## Changes

- Reuse the allocator's GPU candidate filtering and joint matching for capacity admission.
- Admission considers all probed cards; allocation excludes busy and leased cards. Shared GPU
  consumers remain folded into their owner and independent roles retain separate requirements.
- Cover overlapping memory, model, ID and multi-card requirements, successful reassignment and
  admission while fitting hardware is temporarily occupied.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Regression before fix | 74fb1e6 + tests | passed | Seven failing checks reproduced impossible role overlap and inconsistent legacy model filtering |
| Targeted resource tests | working tree | passed | 77 tests across GPU roles/sharing, allocation, devices, cluster placement and prior review regressions |
| pnpm verify | working tree | passed | 713 tests passed; 26 existing skips; lint/types/boundaries/build passed |
| Real GPU / HTTP lifecycle | working tree | passed | Overlapping roles rejected by preflight and submit; different qualifying cards admitted despite occupation; leased-card queue/cancel and shared GPU mapping/cleanup/release checked without model inference |

## Next / open issues

None for this fix. Graphics capabilities remain declarations rather than verified hardware features.
