# Bounded policy integration checks
branch: feat/embodied-eval · status: completed · updated: 2026-11-06

## Goal

Extend `bench calibrate` to check a real registered policy on 2–5 frozen episodes, using the
existing batch, verification, rescore and resource lifecycle within a daemon-owned wall-clock budget.

## Changes

CLI, API and Web reuse the existing calibration API, fixed batches and Job/Trial/Run lifecycle.
Policy checks accept a real model, 2–5 frozen samples and a total budget (default 20 minutes,
maximum 30); one episode is automatically rescored on CPU. Native task success is not an integration
threshold. Catalog policy checks do not raise benchmark calibration or fidelity.

Persist deadline exhaustion, enforce stop intent before recovered Runs are scheduled, cancel initial
verification and automatic rescore, and wait for confirmed cleanup. Late-linked Runs inherit stop
intent. Explicit later CPU rescore preserves a failed acceptance budget; consolidation is refused.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | working tree | passed | 736 tests passed, 26 existing skips; format, lint, types, boundaries and builds passed |
| Contracts, lifecycle and reports | working tree | passed | Explicit synthetic adapter/Run replies; bounds, valid zero score, batch, selected rescore, queue/start/verify expiry, late linkage, restart and catalog separation |
| Real Docker startup deadline | working tree | passed | CLI exits nonzero; real model startup cancelled, cleanup confirmed and lease released |
| Real daemon restart after deadline | working tree | passed | Original deadline retained; interrupted Run becomes `lost`, Docker cleanup confirmed and lease released; validation helper corrected to include that existing terminal state |
| Real GR00T / LIBERO | working tree | passed | Production CLI, two frozen episodes, one model load/shared solve, independent CPU verification and selected rescore; approximately 5 minutes including startup and cleanup |
| Real GR00T / WidowX | working tree | passed | Same checks on the second native endpoint; approximately 3 minutes including startup and cleanup |
| Real report scope and cleanup | working tree | passed | All required checks passed; original native verdicts preserved; Catalog baseline calibration/fidelity unchanged; solve/verifier leases released, no task Docker containers/networks/volumes remain |

## Next / open issues

Use this bounded workflow for routine model onboarding. New benchmark drivers still need their own
native-semantic checks. Full-suite statistical equivalence and independent-process bitwise
repeatability remain unverified by this feature; the stopped full-suite study was not restarted.
