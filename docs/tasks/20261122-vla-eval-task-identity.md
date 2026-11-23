# Stable vla-eval task identities

branch: feat/embodied-eval · status: completed · updated: 2026-11-22

## Goal

Select and verify RoboTwin scenes while reporting the native task once.

## Changes

- Share identity matching between the staged runner and verifier. Other benchmarks
  can identify independent tasks through `taskIdentityFields`.
- RoboTwin lists one entry per native task. An Orbit trial selects a native scene
  by ascending seed or an explicit `sceneSeeds` list.
- Verify checks the exported native scene, scenario variant and trial ordinal
  against the Solve specification and binds the receipt to the aggregate.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | Working tree | passed | 49 script, 1,020 Orbit and 163 Web tests passed. Orbit skipped 32 opt-in tests. Both builds completed. |
| vla-eval tests | Working tree | passed | 33 each on Python 3.8 and 3.11. |
| Offline upstream export and Orbit report | Working tree | passed | Used the published Clean and Randomized scene seeds and the upstream SQLite exporter with synthetic scores. Both reports showed one task and two trials. Wrong seeds and variant swaps were rejected. |
| RoboTwin GPU smoke | Working tree | not_run | Official vla-eval RoboTwin image was unavailable locally. |

## Next / open issues

Validate a non-first same-name scene with a pinned RoboTwin image and a simulator GPU lease.
