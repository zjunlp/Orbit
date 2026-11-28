# Stable review baselines for native evaluations

branch: feat/embodied-eval · status: completed · updated: 2026-11-28

## Goal

Keep pending registration changes visible until the user starts the evaluation or changes the selection.

## Changes

- Compare the latest environment and policies with their first reviewed snapshots. A copy uses the original job's saved values where available.
- Show the model's GPU restrictions and derive the simulator's allowed GPU models from the same resources used to plan Solve.
- Submit the currently displayed registration digests for the daemon to check.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Chromium with an isolated daemon | Working tree | passed | Real LIBERO sample plan with controlled resource edits. Verified repeated and failed refreshes, retry, Back and Continue, value reversion, copying, stale submission rejection and the accepted job's frozen resources. |
| Simulator GPU model review | Working tree | passed | Compared adapter metadata with Solve resources. Chromium displayed the models from a metadata-only RoboLab fixture. |

## Next / open issues

Refresh native registrations when deploying the updated adapter implementation.
