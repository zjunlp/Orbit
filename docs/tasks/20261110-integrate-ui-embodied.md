# Integrate Web discovery and native embodied adapters

branch: feat/integrate-ui-embodied · status: completed · updated: 2026-11-10

## Goal

Combine the six-dimension homepage and filters, the native embodied expansion and the
RoboDojo/RoboLab adapter work without losing either branch's evaluation semantics.

## Changes

- Integrate Web UI commit `c90db08`, embodied expansion through `e65ce92`, and a reviewed
  snapshot of the RoboDojo/RoboLab work; preserve its original working directory.
- Resolve shared adapter, reset-plan and evidence-verification conflicts by retaining all
  environment-specific rules, including RLBench's single-episode restriction and evidence
  finalization before sealing. Retain legacy evidence compatibility.
- Include the RoboDojo image dependency pins and native asset-path preparation with regression coverage.
- Present 30 benchmark families through the existing six independent discovery dimensions.
  Keep RoboDojo/RoboLab visibly pending calibration and preserve historical validation limits.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | integrated working tree | passed | Format, lint, types, module boundaries, tests and builds; 828 tests passed, 26 opt-in tests skipped; 9 existing lint warnings. |
| Python SDK | integrated working tree | passed | 152 tests run: 151 passed, one optional upstream-source check skipped. Real h5py files exercised with explicit synthetic simulators; no h5py skip. |
| Conflict and documentation review | integrated working tree | passed | Environment rules, six-dimension discovery, 30-family catalog, local links and 40-line status checked. |
| Real container compatibility | integrated working tree | passed | Existing RoboLab image, native Python, non-root and no GPU/network; SDK import and real h5py sealing regression passed with an explicit synthetic simulator. Cleanup completed and lease released. |
| Full native GPU calibration | integrated working tree | not_run | Not repeated for integration; RoboDojo/RoboLab full-horizon validation remains tracked in its feature record. |

## Next / open issues

Native task calibration remains tracked in [the RoboDojo/RoboLab record](20261109-robodojo-robolab.md).
