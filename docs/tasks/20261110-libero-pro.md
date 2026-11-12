# Native LIBERO-PRO

branch: feat/embodied-eval · status: completed · updated: 2026-11-11

## Goal

Evaluate independently registered Policies on all 20 conditions from the initial [LIBERO-PRO release](https://github.com/Zxy-MLlab/LIBERO-PRO/tree/eafdb809426b13153aa1e4c42d6601844217dfec).

## Changes

- Pin the upstream fork and generate all 200 BDDLs with a fixed seed. Keep the original perturbator and mark conditions that leave a task unchanged.
- Repair one missing YAML fixture key and three malformed goal conjunctions. Filter released object candidates to native registered objects with compatible regions and distinct instance IDs.
- Use the native parsed instruction, prepared BDDL digest and indexed constructor seed. Record the resulting simulator state digest in evidence.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Native image and full sample plan | working tree | passed | 20 registrations, 200 condition entries and 10,000 generated sample IDs. The 50 indexed states per entry use Orbit's documented seed recipe. |
| Reset and one control step | working tree | passed | All 200 entries ran on the pinned OSMesa image, including the 40 object entries after candidate repairs. |
| Native language and goal comparison | working tree | passed | Spatial Language and Task probes matched native instruction, both RGB streams, end-effector position, reward and termination over three control steps. |
| Preparation regressions | working tree | passed | The pinned image checks the three malformed goals, the missing fixture key, three object candidate constraints and deterministic BDDL catalogs for all 200 entries. |
| Evidence rejection regressions | working tree | passed | A sealed synthetic episode rejects altered instructions, perturbation labels and inconsistent reset-state digests even after resealing. |
| Cross-container reset | 167c5de | passed, sampled | The same Spatial Language sample yielded identical reset-state and camera digests in two CPU containers. A different index changed the state. |
| Orbit solve, CPU verification and rescore | working tree | passed | A registered hold Policy ran the full 220-step Spatial Language horizon. Initial verification and an explicit rescore both returned a valid score of 0. |
| Real OFT checkpoint rollout | working tree | not_run | Orbit queued the calibration while the GPU was occupied. |

## Next / open issues

- Follow-up tests with the existing Spatial OFT Policy covered one Spatial Language sample and one
  Spatial Task sample. [Policy validation record](20261111-embodied-policy-expansion.md#validation)
- The seeded BDDLs and reset states define Orbit's reproducible run conditions. Full-suite model
  evaluation remains open.
