# Embodied review follow-up

branch: feat/embodied-eval · status: completed · updated: 2026-11-21

## Goal

Commit the fixes that passed independent review.

## Changes

- vla-eval validates timeout at task discovery and classifies `model_start` as `policy_start`.
  The LIBERO Spatial manifest checks task and initial-state fields before attributing failures
  and requires a single binary success value.
- The GR00T client checks the action block against the handshake and preserves rejected arrays
  it receives. The server may reject a prediction before sending it.
- OpenVLA-OFT uses the reference seed and excludes the Hugging Face cache marker from checkpoint
  identity. ManiSkill reuses the tabletop asset digest within a Solve.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | selected changes | passed | Checked the exact code selected for the commits in an isolated snapshot. |
| Python 3.11 | selected changes | passed | Embodied SDK 195 passed and 1 skipped, native adapters 79 passed and 6 skipped, vla-eval 14 passed. |
| Python 3.8 | selected changes | passed | 16 targeted SDK tests and 14 vla-eval tests. |
| Full model rollout | selected changes | not_run | Regression checks used CPU fixtures. |

## Next / open issues

The Python LIBERO task identity, download lock and BEHAVIOR source probe remain under review.
Batch evidence retention, mixed-run timeout advice and policy calibration have separate open findings.
