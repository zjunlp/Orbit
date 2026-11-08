# Bounded policy integration checks
branch: feat/embodied-eval · status: completed · updated: 2026-11-07

## Goal
Let `bench calibrate` check a real registered policy on 2–5 frozen episodes within a daemon-owned wall-clock budget, reusing batches, verification, rescore and the resource lifecycle, with crash-safe stop and cleanup.

## Changes
- CLI, API and Web reuse the calibration API, fixed batches and Job/Trial/Run lifecycle. A policy check takes a real model, 2–5 frozen samples and a total budget (default 20 min, max 30); one episode is rescored on CPU automatically. Native task success is not a threshold, and policy checks do not raise Catalog calibration or fidelity.
- Deadline exhaustion is persisted; stop intent applies before recovered Runs are scheduled and is inherited by late-linked Runs. Initial verification and automatic rescore are cancelled and cleanup is awaited. A later explicit CPU rescore keeps a failed budget result; consolidation is refused.
- Cancellation enumerates owned persisted Runs as well as Trial references, including unlinked solve/verify submissions. Reports and completion require terminal, cleaned Runs and released leases across scoring history; cleanup events resume waiting completion, including unlinked Runs. Ordinary batch cancellation keeps its evidence-verification behavior.
- The BenchJob stores a frozen execution-completion time separate from final cleanup completion. The budget stays active through automatic rescore planning; cleanup may finish after on-time execution without a budget failure. Completion callbacks recheck open Trials and owned Runs, so duplicates cannot finish a rescore still being planned. Deadline enforcement reconciles completed execution from actual Trial/Run end times. CLI/Web show "execution finished, cleanup pending"; the final report needs confirmed cleanup and a published completion time.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | working tree | passed | Latest: 747 tests, 26 existing skips; format/lint/types/boundaries/build, CLI/Web contract and cleanup-stage checks |
| Contracts, lifecycle and reports | working tree | passed | Explicit synthetic adapter/Run replies (latest 70 focused tests): bounds, zero score, queue/start/verify/planning expiry, late and interrupted linkage, restart, premature completion markers, cleanup-only deadline crossing, later manual rescore, catalog separation |
| Real Docker startup deadline | working tree | passed | CLI exits nonzero; real model startup cancelled, cleanup confirmed, lease released |
| Real daemon restart after deadline | working tree | passed | Original deadline kept; interrupted Run becomes `lost`, cleanup confirmed, lease released |
| Real GR00T / LIBERO | working tree | passed | Production CLI, two frozen episodes, one model load, independent CPU verify, selected rescore; ~5 min incl. startup/cleanup |
| Real GR00T / WidowX | working tree | passed | Same checks on the second native endpoint; ~3 min incl. startup/cleanup |
| Real report scope and cleanup | working tree | passed | Native verdicts preserved; Catalog calibration/fidelity unchanged; no task containers/networks/volumes remain |
| Real Docker interrupted linkage | working tree | passed | Synthetic CPU fixtures; unlinked batch/service, expired stop intent before recovery; Run cleaned, lease released |
| Real Docker historical verifier cleanup | working tree | passed | Synthetic CPU fixtures; verifier held with active lease after rescore; report waits, then completes on cleanup |
| Initial real Docker fixture timing | working tree | failed | Default 30 s health interval exceeded harness wait; fixture changed to 1 s and rerun passed |
| Real Docker planning deadline | working tree | passed | Synthetic CPU fixtures; 45 s budget active during held rescore planning; late plan cannot launch a verifier |
| Real Docker cleanup-only deadline crossing | working tree | passed | Synthetic CPU fixtures; execution time stays fixed past deadline, report waits for cleanup, no budget failure |

## Next / open issues
The synthetic-fixture Docker checks use real containers and leases and claim no model inference. New benchmark drivers still need their own native-semantic checks. Full-suite statistical equivalence and independent-process bitwise repeatability are not verified here.
