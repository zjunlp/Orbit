# Fixed sequential embodied solve batches
branch: feat/embodied-eval · status: completed · updated: 2026-11-06

## Goal

Load model weights once per fixed solve batch, retaining logical episode trials, independent CPU
verification, partial results, immutable attempt identities and the existing Run/resource lifecycle.

## Changes

- Add opt-in batch size and immutable, ordered execution membership. Keep service-scoped random
  streams explicit; retries must preserve the full batch prefix and execution conditions.
- Migrate run/trial ownership to phase-aware multiple references, with verified SQLite backups.
- Preserve sealed completed episodes after cancellation or later failure. Keep individual rescore,
  shared artifact ownership, legacy jobs and reports compatible.
- Retain previous solve/verify references and outcomes in adopted batch retries; protect valid
  completed episodes and keep cleanup pending through cancellation/submission races.

## Validation

Cost check declared before real execution: measure a two-episode batch and individual CPU
verification (queue, startup, evidence check and cleanup). Target active verification below 10 s
per episode and the representative verification tail below 30 s; project 500 episodes at four
concurrent verifier starts, keeping scheduling assumptions explicit. A failure is reported as a
throughput limitation and does not relax evidence validation or introduce shared verification.

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Contracts/store/lifecycle regression tests | working tree | passed | Single/batch paths, ordered membership, interruption, Run-link recovery, retry retention, cancellation race, report identities and migration rollback |
| Python SDK 3.8 / 3.11 | working tree | passed | 53 checks each; explicit synthetic endpoints and evidence corruption/cancellation controls |
| pnpm verify | working tree | passed | 724 tests passed; 26 existing skips; lint/types/boundaries/build passed |
| Real model batch and saved-evidence checks | working tree | passed | Pinned OpenPI/LIBERO, two initial states, one model service/shared lease, independent CPU verifiers and selected rescore; legacy evidence also rescored after migration |
| Real Docker interruption and deletion | working tree | passed | Native simulator with an explicit stateless calibration fixture; cancellation/later service failure retain completed evidence; cleanup/release and shared job deletion checked |
| Real Docker retry ownership | working tree | passed | Explicit invalid-metadata calibration fixture; compatible adoption retains previous failed shared Run, outcomes and history; selected rescore and final deletion preserve reference ownership |
| Backup restore | working tree | passed | Committed WAL and failure rollback tests; actual pre-migration snapshot restored in an isolated daemon, with legacy job/history unchanged |
| Verification cost measurement | working tree | passed | Active process 1.3–1.6 s, evidence check about 0.12 s, end-to-end about 5.2 s, representative tail 6.9 s; declared budgets met |

The measured cached-image overhead projects to about 11 minutes for 500 episodes with four
concurrent starts under ideal scheduling. Additional queue/startup contention is excluded from
that estimate; these checks do not establish full-suite throughput or statistical equivalence.

## Next / open issues

Cross-Run pooling, shared verification and full-suite equivalence remain separate work. GR00T batch
inference was not run in this change; its connector/SDK coverage does not replace real-model validation.
