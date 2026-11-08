# RoboTwin episode timeline
branch: feat/embodied-eval · status: completed · updated: 2026-11-08

## Goal

Inspect native RoboTwin action targets, joint states, camera views and model-call latency on one Trial timeline.

## Changes

- Export the trajectory during evidence verification. Existing solves gain a timeline when rechecked.
- Record head and wrist cameras at the same control step. Label frames as pre-action and joint states and rewards as post-action.
- Reuse the Web episode viewer with a joint selector and timing for each action chunk.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | working tree | passed | Includes the episode contract, media resolution and timing display tests. |
| Python SDK | working tree | passed | Python 3.8 and 3.11. |
| Recheck existing RoboTwin evidence | working tree | passed | Verified a saved batch and published its single-camera timelines. |
| Native RoboTwin recording | working tree | passed | Real policy and simulator. Each camera's MP4 frame count matched the control steps, and both runs released their leases. |
| LIBERO verifier compatibility | working tree | passed | The verifier exits successfully for saved native evidence whose reference has no environment field. |

## Next / open issues

- Other native environments need their own trajectory exporters.
