# SmolVLA, MolmoAct2, ManiSkill3 and Meta-World
branch: feat/embodied-eval · status: completed · updated: 2026-11-08

## Goal

Add two policy families and two native benchmarks. Check each released checkpoint in a bounded Orbit batch with independent verification and rescore.

## Changes

- `policy-ws` forwards bound observations and validates the frozen action width and replan interval at handshake.
- A LeRobot image serves the published SmolVLA and MolmoAct2 checkpoints on native LIBERO. Each recipe freezes its own warmup and replanning interval.
- Native ManiSkill3 uses the RLinf Plate-25 task on a WidowX controller. Native Meta-World exposes 50 Sawyer tasks with RLinf prompts and the matching π₀.₅ model recipe.
- Meta-World uses the frozen sample seed for both goal construction and reset. The seeded recipe has a separate sample identity.
- [Build and register the four recipes](../../examples/bench-adapters/embodied/benchmarks/tabletop/README.md).

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Workspace and Python SDK checks | working tree | passed | `pnpm verify` and 92 SDK tests on each of Python 3.8 and 3.11. |
| SmolVLA × LIBERO Spatial | working tree | passed | Two frozen episodes, shared model service, CPU verification, selected rescore and cleanup. |
| ManiSkill3 Plate-25 | working tree | passed | Native reset, camera and control step in an offline SAPIEN container with GPU PhysX. |
| Meta-World MT50 catalog | working tree | passed | All 50 environments reset, rendered and stepped with the seeded Orbit recipe. |
| Meta-World frozen reset | working tree | passed | Repeated native reach and push resets reproduced the target, raw observation and first frame. Different seeds changed the scene. |
| OpenVLA-OFT × ManiSkill3 Plate-25 | working tree | passed | Two frozen episodes in one batch, CPU verification and selected rescore. The RLinf decoder retains eight actions with the Bridge normalization and WidowX gripper conversion. |
| MolmoAct2 × LIBERO Goal | working tree | passed | Two frozen episodes in one batch with the released continuous-action model, CPU verification and selected rescore. |
| π₀.₅ × Meta-World MT50 | working tree | passed | Two seeded native tasks in one batch, CPU verification and selected rescore. Eager Torch avoids first-call compilation and autotuning delays. |
| Meta-World reference I/O | working tree | passed | The input mapping and output action slice matched the pinned RLinf transforms. |
| Full-suite statistical comparison | working tree | not_run | Bounded integration checks cover the frozen sample plans. |
