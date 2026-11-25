# Embodied branch review fixes

branch: feat/embodied-eval · status: completed · updated: 2026-11-22

## Goal

Repair the branch review findings and the baseline evidence defects with independently reviewed changes.

## Changes

- vla-eval validates the actual episode task and the suite for LIBERO-Plus results. LIBERO-Pro duplicates use native IDs and resolved suites. Task discovery executes the inspected image, and the official RoboTwin and LIBERO-Mem routes use their declared Conda environments.
- Policy calibration compares the latest rescore with the original score and metrics. New jobs revalidate persisted policy connectors before freezing a registration.
- Resource reports label shared Solve timing even when cgroup samples are missing. Old initial-state tags with only noncanonical seed keys can fall back to a valid total.
- Invalid-evidence pruning protects unclassified or valid donor history and rejects removal of only part of a retained shared Solve.
- BEHAVIOR preserves its Q-score when upstream reports a positive infinite distance ratio for zero movement. EmbodiedLab rejects missing native manifests and upstream integrity failures before treating a result as a score.
- Native sample planning uses the reference RoboCasa365 Diffusion seed and rejects nonpositive repetition counts.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | reviewed changes | passed | Orbit 1,019 passed and 32 skipped. Web 163 passed. |
| Python | reviewed changes | passed | vla-eval 27 each on 3.8 and 3.11. SDK 196 passed and 1 skipped, native adapters 81 passed and 6 skipped, EmbodiedLab 16 passed. |
| Independent reproductions | reviewed changes | passed | Official LIBERO catalog and report data, Docker retagging, signed CPU evidence and SQLite pruning. |
| GPU rollout | reviewed changes | not_run | Reviews exercised task selection, launch specifications and evidence, using CPU checks and explicit simulation fixtures. |

## Next / open issues

- The mixed-run timeout recommendation change was withdrawn after two reviews found pending shared Run cases. Any row containing a measured shared Solve still suppresses per-episode advice.
- Concurrent checkpoint downloads can append to a renamed shared partial after the final checksum. A separate publication or coordination change is needed.
