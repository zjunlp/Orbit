# Validate seed-based benchmark submissions

branch: feat/embodied-eval · status: completed · updated: 2026-11-23

## Goal

Reject vla-eval submissions that request more episodes than can run.

## Changes

- Run the optional seed submission check after resolving tasks and before storing the job.
- Check the configured vla-eval episode limit. For RoboTwin, check the active scene catalog and explicit seed list.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | Working tree | passed | 49 script, 1,029 Orbit, and 163 Web tests passed. Orbit skipped 32 opt-in tests. Both builds completed. |
| vla-eval adapter tests | Working tree | passed | 35 tests on each of Python 3.8 and 3.11. |
| Adapter and Bench submission tests | Staged files | passed | 24 Python tests and the Bench submission test ran against an isolated copy of the staged files. |
| Docker scene discovery and adapter CLI | Working tree and staged files | passed | A test image used published RoboTwin seeds. A valid submission passed, and excess trials, unknown seeds, and mismatched list lengths were rejected. |
