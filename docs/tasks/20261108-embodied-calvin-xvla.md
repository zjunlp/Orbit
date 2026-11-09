# Native CALVIN ABC→D and RoboTwin X-VLA
branch: feat/embodied-eval · status: completed · updated: 2026-11-08

## Goal

Compare two frozen Meta-World samples against the RLinf reference and extend native
evaluation with X-VLA on RoboTwin Clean and π₀.₅ on CALVIN ABC→D.

## Changes

- Register the RoboTwin Clean Cartesian controller with the X-VLA camera, pose, gripper and chunk semantics.
- Freeze the CALVIN sequence catalog and native scene resets. Verify ordered subtask progression and
  report completed length and per-prefix success.
- [RoboTwin X-VLA setup](../../examples/bench-adapters/embodied/ROBOTWIN.md#x-vla-cartesian-evaluation) · [CALVIN setup](../../examples/bench-adapters/embodied/CALVIN.md)

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Workspace and SDK checks | working tree | passed | `pnpm verify` and 95 SDK tests on each of Python 3.8 and 3.11. |
| Meta-World reference comparison | working tree | passed | Two frozen tasks matched the reference verdict. Same-input, same-seed first chunks matched exactly in one process. Independent rollout actions differed. |
| X-VLA Cartesian I/O | working tree | passed | Fixed input and action conversions matched the pinned client. The real model returned a finite native chunk over the policy wire. |
| CALVIN native environment | working tree | passed | Repeated exports matched for the 1,000-sequence catalog. Native resets, both cameras and control steps passed in the offline simulator. |
| CALVIN progression regression | working tree | passed | Synthetic steps cover chunk discard, partial progress and verifier rejection of an inconsistent score. |
| X-VLA × RoboTwin Clean | working tree | passed | Two expert-accepted samples used the reference client's task-name instruction and shared one model service. CPU verification, selected rescore and cleanup passed. |
| π₀.₅ × CALVIN ABC→D | working tree | passed | Two frozen chains exercised real subtask transitions and partial scoring, CPU verification, selected rescore and cleanup. |
| CALVIN report metric | working tree | passed | Rechecked both saved episodes on CPU and aggregated the verified completion counts on a 0–5 scale. Per-prefix success rates match the evidence. |
| Full-suite statistical comparison | working tree | not_run | Integration checks use bounded frozen plans. |
