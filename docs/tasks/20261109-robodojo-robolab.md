# Native RoboDojo and RoboLab integration
branch: feat/robodojo-robolab · status: in_progress · updated: 2026-11-10

## Goal

Add the official RoboDojo and RoboLab environments to the existing native embodied adapter,
and validate one or two representative tasks per benchmark under Orbit resource control.

## Changes

- Keep native task catalogs, reset recipes, observation/action semantics and success conditions frozen with source and asset identities.
- Reuse policy bindings, sample plans, episode evidence and independent CPU verification.
- Require an RTX-capable GPU and retain each upstream Isaac Sim version. Freeze the official RoboLab container source separately from its Git release metadata.
- Keep CPU verification usable without root privileges. Apply NVIDIA's documented Vulkan version-reporting workaround only after a bounded query confirms an affected Linux R535.256+ driver.
- Match published asset ordering to the content-digest implementation, including file/directory prefixes.
- Finalize native evidence writers before sealing. RoboLab HDF5 close changes file metadata after flush; late close originally invalidated the sealed digest. Keep the failed evidence unchanged and rerun with the corrected lifecycle.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Official source inspection | working tree | passed | RoboDojo `f57e1633ffed59761bc8e568cfe7530c4b33381c`; RoboLab `9cce00cadd5dc575fd2b8ea3836f5bdcde574229`. |
| Workspace checks | working tree | passed | `pnpm verify`: format, types, module boundaries, tests and build. |
| Python SDK checks | SDK `946d5b80` | passed | 133 tests in an isolated Python 3.11 environment; native simulator doubles are explicitly synthetic. |
| Contract interoperability | working tree | passed | Both Python adapter plans parse through the actual TypeScript contracts, preserving RTX model constraints and CPU-only verification. |
| CUDA and Isaac Sim prerequisites | working tree | passed | Actual CUDA memory operations and the official 5.0/5.1 headless compatibility checkers passed in Orbit. This does not establish task calibration. |
| RoboLab CPU entry point | SDK `946d5b80` | passed | Native Python entry point imports the evidence SDK as uid/gid 65534 with no GPU or network; no simulator import. |
| RoboLab native startup and official replay | SDK `946d5b80` | passed | Actual RGB/control smoke and a 648-step official successful replay; replay output independently checked on CPU. Replay is not a policy performance result. |
| Initial RoboLab batch evidence verification | SDK `946d5b80` | failed | Both full native episodes finished, but native HDF5 close occurred after sealing. Preserve these invalid results; corrected execution is being rerun. |
| Evidence-finalization regression | SDK `22a58074` | passed | Real h5py files with synthetic environments cover successful/failed episodes, cancellation and finalizer errors. |
| Corrected full-horizon GPU batch checks | SDK `22a58074` | not_run | RoboLab rerun and RoboDojo runtime preparation are in progress. |

## Next / open issues

Finish native startup checks, then run two tasks per benchmark with explicit hold controls and independent verification. Keep the official RoboLab successful-recording replay separate from policy performance. No trained-policy calibration or full-suite equivalence is claimed.
