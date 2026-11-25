# Unify native RoboTwin on the current upstream revision

branch: feat/embodied-eval · status: completed · updated: 2026-11-24

## Goal

Use one pinned upstream RoboTwin revision for new native evaluations so the preparation recipe,
registration script, assets and simulator agree.

## Changes

- Use upstream `ea8b211` for Clean and Randomized. Default to the full Clean suite and use stable
  suite registration names. Store the source, image and evaluation protocol with the registration.
- Build the simulator from pinned source and a reusable dependency layer. Use the same simulator
  for standard joint control and specialized controller registrations.
- Retire the old source choice. Generate a new frozen sample plan when adopting the new registration.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Orbit CLI preparation | working tree | passed | Registered both stable names and listed 50 tasks per suite from the pinned checkout with XPolicyLab uninitialized. Registration rejected the prior checkout and simulator. |
| Simulator image and standard control | working tree | passed | Built from pinned source with existing compatible dependencies. Both suites produced an expert-accepted sample plan and passed native reset, RGB and joint control on a real GPU. |
| Model-specific registrations and native control | working tree | passed | Registered the shared control recipes for both suites and the X-VLA and LingBot-VA Clean recipes with local policy images and weights. On a GPU, sampled Clean resets and controls passed for Fast-VLA, absolute end-effector pose, both joint chunk sizes, X-VLA and LingBot-VA. The current references also passed LingBot-VLA 2.0's compatibility check. |
| Sample plan replacement | working tree | passed | Submission validation accepted the current plan and rejected an archived plan for the prior evaluator under the same benchmark name. |
| Fresh dependency installation | working tree | failed | Canceled while downloading Debian packages. |
| `pnpm verify` and `pnpm test:embodied-sdk` | working tree | passed | Repository and SDK suites passed with their declared skips. |

## Next / open issues

- Full-suite model performance on the current revision remains unmeasured.
