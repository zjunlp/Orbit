# Fixed sequential embodied solve batches
branch: feat/embodied-eval · status: completed · updated: 2026-11-07

## Goal
Load model weights once per fixed solve batch while keeping logical episode trials, independent CPU verification, partial results, immutable attempt identities and the existing Run/resource lifecycle.

## Changes
- Opt-in batch size with immutable, ordered execution membership. Service-scoped random streams are explicit; retries must keep the full batch prefix and execution conditions.
- Run/trial ownership migrates to phase-aware multiple references, with verified SQLite backups.
- Sealed completed episodes survive cancellation or later failure. Individual rescore, shared artifact ownership, legacy jobs and reports stay compatible.
- Adopted batch retries keep previous solve/verify references and outcomes; cleanup stays pending through cancellation/submission races.
- Model startup and Torch initialization happen once per solve Run; each episode resets its state while the declared service random stream continues (documented in the GR00T guide).

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Contracts/store/lifecycle regressions | working tree | passed | Single/batch paths, ordered membership, interruption, Run-link recovery, retry retention, cancellation race, report identities, migration rollback |
| Python 3.8 / 3.11 SDK | working tree | passed | 53 checks each; explicit synthetic endpoints, evidence corruption/cancellation controls |
| `pnpm verify` | 61f8263 + documentation | passed | 724 tests, 26 existing skips; lint/types/boundaries/build |
| Real OpenPI/LIBERO batch and saved evidence | working tree | passed | Two initial states, one model service/shared lease, independent CPU verifiers, selected rescore; legacy evidence rescored after migration |
| Real Docker interruption and deletion | working tree | passed | Explicit stateless calibration fixture; cancellation/later service failure keep completed evidence; cleanup, release, shared job deletion |
| Real Docker retry ownership | working tree | passed | Explicit invalid-metadata fixture; adoption keeps previous failed shared Run, outcomes and history; rescore and deletion keep ownership |
| Backup restore | working tree | passed | WAL and rollback tests; real pre-migration snapshot restored in an isolated daemon, legacy job/history unchanged |
| Verification cost measurement | working tree | passed | Active process 1.3–1.6 s, evidence check ~0.12 s, end-to-end ~5.2 s, tail 6.9 s; under the 10 s / 30 s targets |
| Real GR00T / LIBERO batch | 61f8263 | passed | Two initial states, one shared solve/model process, no restart, independent CPU verification |
| Real GR00T / WidowX batch | 61f8263 | passed | Two scene resets, one shared solve/model process; simulator and policy share the owning GPU role |
| Episode isolation and selected rescore | 61f8263 | passed | Counters restart per episode; frozen identities verified; rescore keeps the other Trial, shared solve, evidence and report episode references |
| WidowX proprioception-only reset assertion | 61f8263 | failed | Invalid development check: the visual-matching recipe fixes robot pose and varies object placement |
| WidowX native reset inspection | 61f8263 | passed | Audited pinned reset recipe; distinct object placements in both first frames; check corrected, no product change |
| Resource cleanup | 61f8263 | passed | Solve and verifier leases released; no task containers, networks or volumes remain |

## Next / open issues
Measured cached-image overhead projects to about 11 minutes per 500 episodes at four concurrent verifier starts under ideal scheduling, excluding queue/startup contention. Cross-Run pooling, shared verification, full-suite throughput, statistical equivalence and independent-process bitwise repeatability remain separate work.
