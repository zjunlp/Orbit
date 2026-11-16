# Hy-Embodied-0.5-VLA on RoboTwin 2.0

branch: feat/embodied-eval · status: completed · updated: 2026-11-16

## Goal

Run the released Hy-VLA checkpoint with native RoboTwin end-effector control.

## Changes

- Register the Clean and Randomized suites with the absolute end-effector protocol. Read live pose and gripper state and retain the policy's upstream per-control camera history.
- Build and validate the [pinned policy image and asset registration](../../examples/bench-adapters/embodied/policies/hy-embodied-vla/README.md) through the shared action service.

## Validation

| Check | Result | Notes |
| --- | --- | --- |
| Runtime build and checkpoint | passed | Built the image, imported the upstream policy offline and verified the release SHA-256. |
| Native registration | passed | Registered both 50-task suites. Two absolute pose controls passed on Clean `adjust_bottle`. |
| Policy semantic registration | passed | The fixed policy profile accepts the native recipe and rejects changed quaternion conventions and action order. |
| Shared action service evidence | passed | A local WebSocket with a synthetic policy checks that invalid chunks are recorded as rejected evidence before native control. |
| Bounded real-policy rollout | passed | Eight controls on GPU 0 with Clean `adjust_bottle`, seed 100001. Covered the second network prediction and matched the saved policy outputs to the applied controls on CPU. |
| Full-horizon evaluation | not_run | Used a short control budget. |
