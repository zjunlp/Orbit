# Frozen benchmark task sets (E1)
branch: feat/run-trajectory · status: completed · updated: 2026-11-14

## Goal
Create reproducible evolve/gate/final task splits and preserve their identity in submitted jobs.

## Changes
- Shared split, file provenance and submission contracts; deterministic SHA-256 ordering and suite-aware quotas.
- Daemon-owned split publication to user directories, typed clients and `bench split` / `run --tasks-file`.
- Byte/hash, task-selection, benchmark version/settings and listing validation before job/trial creation.
- Persist job taskSet and file provenance without raw content or a task-set store; legacy reads unchanged.
- Preserve task-file freezes during consolidation and refresh ordinary appended selections.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Focused service/CLI/store/split/consolidation checks | E1 working tree | passed | 106 checks; synthetic subprocess adapter, real store/files/handlers, execution paused |
| pnpm verify | E1 working tree | passed | 887 core + 136 Web + 5 script tests; 28 opt-in skipped; format, lint, types, boundaries and builds passed with isolated Python CI requirements |
| Real daemon and CLI | E1 working tree | passed | Reproducible files, frozen submission, two fixture trials completed, byte tampering rejected; synthetic adapter, actual processes, no model/GPU |

## Next / open issues
- E2 decision/statistics core follows.
- Runtime data/weights/images and dirty source contents are not frozen by a task-file manifest.
- Split files remain user-owned; no gate decision or Web split screen in this package.
