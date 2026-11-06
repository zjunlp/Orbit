# GR00T action validation before conversion
branch: feat/embodied-eval · status: completed · updated: 2026-11-06

## Goal

Reject malformed GR00T action timing and raw values before conversion can hide invalid model outputs.

## Changes

- Require action time indices to be the dense, zero-based prediction window before inference.
- Validate numeric types and finite raw values across the full predicted chunk before gripper conversion.
- Extend the existing episode failure path to archive rejected numeric arrays without pickle, with
  source observation and diagnostic metadata. Preserve earlier controls; keep invalid calls out of scores.
- Cover sparse/shifted/reversed/duplicate indices, valid short windows, non-finite values in consumed
  and unused action fields, bounded non-numeric diagnostics and failures after a completed chunk.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Regression tests before fixes | bb0b234 + tests | passed | Reproduced timing acceptance and converted infinite gripper outputs admitted as valid |
| Python SDK 3.8 / 3.11 | working tree | passed | 43 checks each; synthetic ZeroMQ endpoints exercise driver and saved-evidence verification |
| pnpm verify | working tree | passed | 696 tests passed; 26 existing skips; lint/types/boundaries/build passed |
| Isolated CPU Run | working tree | passed | 22 driver/transport checks inside the native Gym image; synthetic endpoints, no model or simulator; cleanup done and lease released |
| Saved-evidence compatibility | working tree | passed | Four OpenPI/GR00T positive and calibration evidence sets rescored on CPU; original solves and results retained, cleanup done and leases released |
| Real model GPU inference | working tree | not_run | Protocol checks use CPU endpoints; model weights and simulator behavior are unchanged |

## Next / open issues

Full-suite numerical/statistical parity remains unverified. Generated registrations need the new
implementation digest; saved evidence retains its original solve implementation identity.
