# LingBot-VLA 2.0 on native RoboTwin

branch: feat/embodied-eval · status: completed · updated: 2026-11-13

## Goal

Run the published LingBot-VLA 2.0 policy on its pinned native RoboTwin suites.

## Changes

- LingBot-VLA 2.0 serves the published RoboTwin checkpoint in FP32 with native
  Clean and Randomized joint control on RoboTwin `13c3c47`. The saved LeRobot
  processors define the three RGB views and the 55-to-14 action mapping.
  [Author evaluation instructions](https://github.com/Robbyant/lingbot-vla-v2/blob/main/experiment/robotwin/README.md) ·
  [LeRobot checkpoint](https://huggingface.co/lerobot/lingbot_vla_v2_robotwin/tree/54f79a4b6e9166bda91b5010088097ff3191bca2)
- The generator defaults to the authors' RoboTwin revision. For a cross-revision
  experiment, reuse the existing Policy or generate it with `--allow-other-revision`.
  The job records the selected benchmark protocol and checks semantic compatibility.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Repository and Python checks | working tree | passed | `pnpm verify`, Python 3.11 SDK and adapter discovery, and the documented Python 3.8 SDK subset. |
| LingBot-VLA 2.0 assets and processors | working tree | passed | ModelScope transfer matched the published weight SHA-256. The real offline LeRobot processors accepted three uint8 views and 14 joint values and mapped a synthetic 50 × 55 tensor to finite 50 × 14 controls. |
| LingBot-VLA 2.0 and RoboTwin | working tree | passed | The FP32 policy completed one frozen `adjust_bottle` episode per Clean and Randomized suite on GPU 1. Native success, CPU verification and rescore agreed in both suites. |
| Cross-revision configuration | working tree | passed | The generator rejected the September reference by default. With `--allow-other-revision` the real image and weights produced the same Policy as the authors' revision. The regression checks that a changed joint order still fails. |

## Next / open issues

The model short checks cover one frozen sample per suite at the authors' revision.
The September revision has a registration check.
