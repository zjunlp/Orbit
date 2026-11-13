# Native Colosseum V2

branch: feat/embodied-eval · status: completed · updated: 2026-11-11

## Scope

- Read the 16 single-arm tasks, 12 bimanual tasks, 21 perturbation presets and per-task horizons from the pinned [Colosseum V2 evaluator](https://github.com/jstmn/ColosseumV2/tree/d16081b3ff6ea4516821f4ad5f66daccaf51c4ed). The adapter preserves native exclusions and exposes 42 morphology and preset registrations.
- Expose the native camera order, unnormalized ACT state, perturbed instruction and controller action through separate single-arm and bimanual profiles. Orbit uses one independently seeded native environment per episode.
- Match the official stopping and scoring rules. Episodes run through the task-specific horizon and report both `success_once` and `success_at_end`.

## Assets and validation

| Check | Result | Notes |
| --- | --- | --- |
| Pinned task list | passed | The official evaluator supplies 28 unique task IDs across two morphologies. |
| Offline registration and sample plans | passed | 42 registrations expose 588 task and preset pairs. The upstream evaluator excludes 70 pairs. Missing assets affect 63 otherwise applicable pairs. The remaining 455 pairs are available. The unperturbed plans include 14 single-arm and 10 bimanual tasks. |
| Asset preparation, applicability and scoring regressions | passed | Three tests each on Python 3.8 and 3.11 cover failed downloads, native exclusions and the distinction between success during the episode and success on the last step. |
| Soda cabinet fixtures | passed | Both XML files and their textures match their member CRCs in the pinned [official RoboCasa archive](https://huggingface.co/datasets/haosulab/RoboCasa/tree/8765d4ada3eb7a95a1544044dbdd572a050fefb8). |
| Reset and one control step | passed | All 24 asset-ready unperturbed tasks passed in native GPU PhysX, including both the soda cabinet and the bundled drawer. |
| Single-arm fixed-action reference | passed | `RaiseCube-v1` with `NONE`, seed 0. All three initial RGB streams, initial proprioception and instruction matched the upstream wrapper. Reward, instantaneous success, horizon and both aggregate scores matched over 92 control steps. |
| Bimanual fixed-action reference | passed | `DualArmPickCube-v1` with `NONE`, seed 0. All four initial RGB streams, initial proprioception and instruction matched the upstream wrapper. The control and scoring checks also matched over 213 steps. |
| Combined perturbation reference | passed | `RaiseCube-v1` with `ALL`, seed 0. Both paths applied the same receiving-object exclusions and produced matching perturbed instructions, initial RGB, proprioception and 92-step results. |
| Official single-arm ACT checkpoint | passed, input and output shapes | Loaded the EMA weights on CPU and checked 25 proprioceptive values, 7 controls, 30 queries and the CLIP weights. The checkpoint uses the controller's action units directly. |
| Full native model sweep | not run | The official sweep evaluates 100 parallel environments for each applicable task and preset. |

The pinned fork provides cabinet model `45427`. The original download host for the fixed PartNet Mobility cabinet models `1005` and `1027` was unreachable during setup. Registrations surface the affected drawer and cabinet tasks as unsupported while their assets are absent. [ManiSkill asset host issue](https://github.com/mani-skill/ManiSkill/issues/1489)
