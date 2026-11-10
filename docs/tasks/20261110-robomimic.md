# Native RoboMimic

branch: feat/embodied-eval · status: completed · updated: 2026-11-10

## Goal

Register all five classic proficient-human (PH) simulation tasks.

## Changes

Freeze PH v1.5.1 metadata and register low-dimensional and RGB profiles per task. Reuse frozen sample plans and independent CPU evidence verification. [Registration guide](../../examples/bench-adapters/embodied/ROBOMIMIC.md)

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Official catalog and native CPU simulation | working tree | passed | All five PH metadata files and all ten task and observation registrations passed reset, observation and control checks. |
| Upstream reference | working tree | passed | Lift and Transport matched seeded upstream observations, rewards and verdicts on eight fixed commands each. Separate PH action replays reached native success in both tasks. |
| Orbit solve, verify and rescore | working tree | passed | A scripted hold policy exercised the full-horizon Lift failure. CPU rescore reproduced the verdict. |
| Workspace and SDK | combined working tree | passed | pnpm verify and Python 3.11 passed with two SDK skips. |
| Python 3.8 full SDK discovery | combined working tree | failed | The RoboDojo path containment test also fails on the unchanged base because Python 3.8 lacks Path.is_relative_to. |

## Next / open issues

The CoRL model zoo targets a legacy simulator. Trained-policy and full-suite model evaluation remain unverified.
