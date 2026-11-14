# RoboTwin 2.0 September suites

branch: feat/embodied-eval · status: completed · updated: 2026-11-13

## Goal

Register the September Clean and Randomized suites alongside the original RoboTwin release.

## Changes

- RoboTwin 2.0 registers the September evaluator as distinct full Clean and Randomized suites.
  Each has 50 tasks. The new scene and instruction RNG change the sample identity.
  The native instruction splits are seen in Clean and unseen in Randomized.
  [Upstream simulator](https://github.com/RoboTwin-Platform/RoboTwin/tree/ea8b21121ebb3cd201ff5b3fe361944ac94eda3f)

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| RoboTwin September Clean and Randomized | working tree | passed | Each registered 50 tasks. On GPU 1, the native expert accepted `place_object_scale` seed 100000 in both suites. Each sample restored all three cameras, generated an instruction from the configured split and accepted one 14-joint control. |

## Next / open issues

Validation samples one scene per suite.
