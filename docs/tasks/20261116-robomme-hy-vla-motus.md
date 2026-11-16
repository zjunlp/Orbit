# Native RoboMME and the no-history π₀.₅ baseline

branch: feat/embodied-eval · status: completed · updated: 2026-11-16

## Goal

Evaluate policies against the complete public test split of native RoboMME.

## Changes

- [RoboMME](../../examples/bench-adapters/embodied/benchmarks/robomme/README.md) freezes all 16 tasks and 800 public-test episodes and uses native Panda joint-angle control, stopping and scoring.
- The [official no-history π₀.₅ runtime](../../examples/bench-adapters/embodied/policies/robomme-pi05/README.md) copies the checked tokenizer into its private cache so OpenPI resolves the file inside that cache.
- The same round also validated [Hy-VLA](20261116-hy-embodied-vla.md) and [Motus](20261116-motus.md) on RoboTwin 2.0.

## Validation

| Check | Result | Notes |
| --- | --- | --- |
| Public test metadata | passed | Four suites with 50 native episode indices, seeds and difficulty tags per task. The native builder resolved all 800 entries. |
| Native reset and control | passed | Built the pinned simulator image. StopCube, VideoUnmask, PickHighlight and PatternLock each passed GPU reset, observation validation and one native control. |
| CPU scoring regression | passed | Checked native success, timeout and step error, plus rejection of a tampered initial state. |
| Runtime build and checkpoint | passed | Built the model image, imported the upstream policy offline and verified the release SHA-256. |
| Policy registration and random-stream contract | passed | The fixed profile rejects mismatched state units and action order. A synthetic policy test verifies a reset on each new episode connection. Orbit preserves the episode scope in the saved batch and Trial view. |
| Repository checks | passed | `pnpm verify`, all 73 documented Python 3.8 shared SDK tests, and Python 3.11 discovery with 188 SDK and 55 adapter tests passed and four optional checks skipped. |
| Bounded real-policy rollout | passed | Seventeen controls on GPU 0 with `PickHighlight` at public test index 0. Recorded two 20 × 8 action chunks and matched the saved policy outputs to the applied controls on CPU. |
| Real policy across episodes | passed | On GPU 0, replayed the same frozen observation twice per episode on one service. The two queries differed within each episode and repeated across episode connections. |
| Full-horizon evaluation | not_run | Used a short control budget. |
