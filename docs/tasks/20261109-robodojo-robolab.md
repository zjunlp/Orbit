# Native RoboDojo and RoboLab integration
branch: feat/robodojo-robolab · status: completed · updated: 2026-11-10

## Goal

Add the official RoboDojo and RoboLab environments to the existing native embodied adapter,
and validate one or two representative tasks per benchmark under Orbit resource control.

## Changes

- Keep native task catalogs, reset recipes, observation/action semantics and success conditions frozen with source and asset identities.
- Reuse policy bindings, sample plans, episode evidence and independent CPU verification.
- Require an RTX-capable GPU and retain each upstream Isaac Sim version. Freeze the official RoboLab container source separately from its Git release metadata.
- Keep CPU verification usable without root privileges. Apply NVIDIA's documented Vulkan version-reporting workaround only after a bounded query confirms an affected Linux R535.256+ driver.
- Run RoboDojo from its native repository so relative material paths remain valid. Preload and verify its native utility namespace before Kit exposes OpenCV’s colliding `utils` package; never overwrite an existing foreign module.
- Generate the native RoboDojo x5 robot configuration with container paths before hashing assets; preserve existing custom configurations.
- Constrain auxiliary RoboDojo packages without changing the pinned simulator stack; retain and report the upstream IsaacLab/Isaac Sim livestream dependency conflict. Headless evaluation only.
- Match published asset ordering to the content-digest implementation, including file/directory prefixes.
- Finalize native evidence writers before sealing. RoboLab HDF5 close changes file metadata after flush; late close originally invalidated the sealed digest. Keep the failed evidence unchanged and rerun with the corrected lifecycle.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Official source inspection | working tree | passed | RoboDojo `f57e1633ffed59761bc8e568cfe7530c4b33381c`; RoboLab `9cce00cadd5dc575fd2b8ea3836f5bdcde574229`. |
| Workspace checks | working tree | passed | `pnpm verify`: format, types, module boundaries, 825 tests and build; 26 opt-in integration tests skipped. |
| Python SDK checks | SDK `ff6d557a` | passed | 136 tests in an isolated Python 3.11 environment, including native checkout metadata, real h5py finalization and namespace collision regression; native simulator doubles are explicitly synthetic. |
| Contract interoperability | working tree | passed | Both Python adapter plans parse through the actual TypeScript contracts, preserving RTX model constraints and CPU-only verification. |
| CUDA and Isaac Sim prerequisites | working tree | passed | Actual CUDA memory operations and the official 5.0/5.1 headless compatibility checkers passed in Orbit. This does not establish task calibration. |
| RoboLab CPU entry point | SDK `946d5b80` | passed | Native Python entry point imports the evidence SDK as uid/gid 65534 with no GPU or network; no simulator import. |
| RoboLab native startup and official replay | SDK `946d5b80` | passed | Actual RGB/control smoke and a 648-step official successful replay; replay output independently checked on CPU. Replay is not a policy performance result. |
| Initial RoboLab batch evidence verification | SDK `946d5b80` | failed | Both full native episodes finished, but native HDF5 close occurred after sealing. The invalid evidence is preserved; corrected execution and independent verification passed below. |
| Evidence-finalization regression | SDK `22a58074` | passed | Real h5py files with synthetic environments cover successful/failed episodes, cancellation and finalizer errors. |
| Corrected RoboLab full-horizon GPU batch | SDK `22a58074` | passed | Two genuine native hold-control episodes; independent CPU verification and rescore passed, prior history retained, all cleanup confirmed and leases released. |
| Initial RoboDojo native startup | SDK `e00a6822` | failed | Kit starts, but task import fails for `utils.load_file`. The native smoke report retains the exception even when Isaac shutdown returns process exit code zero. |
| Corrected RoboDojo native startup | SDK `ff6d557a` | passed | Genuine frozen-layout reset, three original RGB cameras and one native control step passed after preloading the checked utility namespace; cleanup and lease release confirmed. |
| RoboDojo full-horizon GPU batch | SDK `ff6d557a` | passed | Two genuine native hold-control episodes; independent CPU verification and rescore passed, prior history retained, all cleanup confirmed and leases released. |

## Next / open issues

Native integration and two sampled full-horizon checks per benchmark are complete. The official RoboLab successful-recording replay remains separate from policy performance. Trained-policy evaluation, a successful RoboDojo oracle and full-suite equivalence are unverified.
