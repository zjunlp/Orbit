# Integrate completed local branches

branch: fix/integrate-local-branches · status: completed · updated: 2026-11-10

## Goal

Integrate completed local work into main while keeping the separate RLE-Bench,
EmbodiedCLBench and EmbodiedLab harness work outside this merge.

## Changes

- Integrate evaluation-configuration naming, native benchmark adapters and task-account
  isolation, independent verifier GPU constraints, and completed RoboDojo/RoboLab fixes.
- Reconcile the earlier robotics snapshot with its original branch history; retain the
  existing embodied environments, evidence lifecycle and six-dimension discovery.
- Present 34 benchmark families with consistent documentation and validation limits.
  Preserve compatible Method API fields and CLI options; independent Methods remain undesigned.
- Align the WANDR catalog description with its recorded native empty calibration and link
  the implemented RoboDojo adapter from the availability matrix.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | integrated working tree | passed | Format, lint, types, boundaries, tests and builds; 838 tests passed, 28 opt-in tests skipped, 9 existing lint warnings. |
| Real Docker account isolation | integrated working tree | passed | Both opt-in command-account tests passed on a dedicated temporary daemon: non-root command, root independent verifier, phase-specific fixture credentials, output collection and confirmed cleanup. |
| Python SDK | integrated working tree | passed | 154 tests run, 153 passed; one optional upstream-source check skipped. Real h5py files and explicit synthetic simulator fixtures; no native GPU evaluation implied. |
| Catalog and documentation | integrated working tree | passed | All 34 family identities checked, excluded harnesses absent, relative file links resolve and status remains within 40 lines. |
| Full native GPU suites | integrated working tree | not_run | Not repeated for this merge. Bounded native checks and remaining limits are retained in the individual feature records. |

## Next / open issues

The excluded harness branch remains independent. Original dataset, judge, hardware and
full-suite parity requirements remain as documented in each adapter's feature record.
