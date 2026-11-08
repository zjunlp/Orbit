# LIBERO episode timeline
branch: feat/embodied-eval · status: completed · updated: 2026-11-08

## Goal

Review LIBERO's saved camera frames, executed actions, end-effector pose, gripper state and reward in the existing Web timeline.

## Changes

- Reuse the native trajectory exporter and expose verified LIBERO episodes, including historical runs when rechecked.
- Align the saved pre-action frames with post-action state and reward. Show the horizon as truncation and keep settle steps outside playback.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | working tree | passed | Web and shared contract checks. |
| Python SDK | working tree | passed | Python 3.8 and 3.11, including LIBERO trajectory export. |
| Native saved evidence | working tree | passed | Frame counts and terminal flags checked on real LIBERO success and horizon runs and a RoboTwin three-camera run. An Orbit evidence recheck published the LIBERO review entry. |
