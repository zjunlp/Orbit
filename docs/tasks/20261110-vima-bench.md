# Native VIMA-Bench

branch: feat/embodied-eval · status: completed · updated: 2026-11-10

## Goal

Register all four official VIMA-Bench test partitions and serve the released VIMA 20M Policy independently.

## Changes

Preserve native prompts, segmentation and pick/place primitives. Use frozen sample plans and independent CPU evidence verification. [Registration guide](../../examples/bench-adapters/embodied/VIMA-BENCH.md)
The Policy image manifest records the file digests of the SDK modules included in its build.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Official catalog and native CPU simulation | working tree | passed | All four partitions and all 42 partition/task entries across 17 templates passed reset, observation and control checks. |
| Upstream reference | working tree | passed | Official 20M inference on Follow Order matched the headless upstream example's actions and termination sequence. |
| Orbit solve, verify and rescore | working tree | passed | VIMA 20M succeeded on sampled Visual Manipulation and Follow Order episodes. CPU rescore reproduced the verdicts. |
| Workspace and SDK | combined working tree | passed | pnpm verify and Python 3.11 passed with two SDK skips. |
| Python 3.8 full SDK discovery | combined working tree | failed | The RoboDojo path containment test also fails on the unchanged base because Python 3.8 lacks Path.is_relative_to. |
| SDK manifest regression | SDK manifest fix | passed | Matching images pass. Modified, added and removed production files invalidate the old manifest. Changes to excluded test files leave it valid. |
| Docker Policy registration | SDK manifest fix | passed | The legacy Policy image was rejected. Registration pinned the rebuilt image, whose 30 packaged SDK files matched the manifest. The existing simulator image passed its own check. |
| Prompt and episode SDK regressions | working tree | passed | Synthetic object and scene prompts preserve RGB, masks, object IDs and action bounds. Two loopback WebSocket connections exercise history accumulation and reset with synthetic inference. |

## Next / open issues

Full-suite model evaluation remains unverified.
