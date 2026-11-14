# Fast-WAM LIBERO suites and LeRobot 0.7.0

branch: feat/embodied-eval · status: completed · updated: 2026-11-13

## Goal

Extend Fast-WAM to all four native LIBERO suites and provision a LeRobot 0.7.0 runtime.

## Changes

- The native Fast-WAM recipe supports LIBERO Spatial, Object, Goal and Long in both
  released modes. The LeRobot 0.7.0 image supports the existing SmolVLA entry point
  and provides the published LeRobot FastWAM and LingBot-VLA 2.0 packages.
  [Fast-WAM evaluator](https://github.com/yuantianyuan01/FastWAM/blob/7faa71108368fbb3b6885649f112af607427a2d4/experiments/libero/eval_libero_single.py) ·
  [LeRobot 0.7.0](https://github.com/huggingface/lerobot/releases/tag/v0.7.0)

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Fast-WAM and LeRobot | working tree | passed | Orbit reports ten tasks in each suite. One Object sample completed on GPU 1 and passed CPU verification and rescore. LeRobot 0.7.0 passed dependency checks and ran offline GPU predictions with SmolVLA and MolmoAct2. |

## Next / open issues

The new model rollout covers Object in first-frame mode. Goal and Long were checked at registration.
