# Independent policies and native embodied benchmarks
branch: feat/embodied-eval · status: completed · updated: 2026-11-07

## Goal
Run planned episodes through independent policy and benchmark endpoints on a pinned native LIBERO/OpenPI path, with reference parity controls, while keeping legacy adapters, trial identities, reports and the Run/resource lifecycle.

## Changes
- Daemon-owned policy registration (HTTP/client/CLI) with frozen policy, binding and ordered sample-plan snapshots, reusing existing services, leases, Runs and store. Planned trials use sampleRef without seed and report v2; legacy seeds and report fingerprints stay intact. Report identity covers the full model/runtime snapshot, benchmark registration and binding.
- Python 3.8+ SDK and a direct official LIBERO/OpenPI path without vla-eval: native verdicts, requested chunks, executed actions, initial states, optional video. CPU-only verification rescores from sealed solve evidence; both implementations are archived.
- Pinned upstream sources, checkpoint and normalization content, with audit, image build, registration and sample-planning tools. Calibration fixtures are marked and excluded from the real-model catalog. Local configs and runtime assets stay outside Git.
- GPU mode prefers NVIDIA CDI only in directories Docker reports as enabled; otherwise, and on bounded query failure, the legacy GPU flag is used. No host Docker changes needed.
- Parity tooling keeps the official evaluation function, instruments its environment/client boundaries and stops after the first completed episode. Plans and fingerprints are frozen before reference execution; raw outputs stay outside Git. Independent-process bitwise comparison and the shared-compiled-runtime protocol control are separate verdicts; the control uses real inference on two independently initialized key-0 streams without relaxing tolerances. NumPy scalar counters serialize without changing the official numerator/denominator.
- Rescore provenance: repeated consolidation keeps the original execution trial; new evidence records its solve Run. Verification recomputes sample identity, checks evidence against frozen sample/binding/policy/reference/implementation snapshots and binds the receipt to the current trial and solve Run. Legacy evidence without recoverable original-trial provenance fails rather than inventing it.
- Plan fingerprints and paired statistics share normalized frozen conditions, including effective per-task resources and timeout. Consolidation rejects differing frozen budgets (all five dimensions, both job modes, retained invalid retries, transport aliases) before mutating records; the job timeout keeps precedence and appended tasks keep source budgets.
- Explicit and default reference content resolve through one digest-checked function; omitted references stay pinned by profileDigest and reject changed packaged content.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Source/checkpoint/image audit | working tree | passed | Pinned upstream commits/files, full content fingerprints, immutable runtime images |
| `pnpm verify` | working tree | passed | Latest: 5 script + 620 Orbit + 69 Web tests, 26 existing skips; lint/types/boundaries/build |
| Python 3.8 / 3.11 SDK checks | working tree | passed | Latest 27 each; synthetic endpoints, real WebSocket transport, evidence corruption, NumPy counters, resealed snapshots, default/explicit reference agreement |
| Docker CDI detection regression | working tree | passed | Enabled/disabled/missing CDI, malformed response, query failure; real GPU run uses legacy path |
| Real Docker / LIBERO negatives | working tree | passed | Explicit stateless calibration fixture; two native initial states; horizon failures and cleanup |
| Single-sample rescore, restart, archives | working tree | passed | No new solve; other trial unchanged; restart keeps jobs; new verifier accepts saved positive/negative evidence |
| Real VLA positive (CPU and GPU) | working tree | passed | Pinned π₀.₅ weights, native LIBERO success; GPU run on leased card, main role has no GPU; independent verify, cleanup |
| Deterministic preprocessing, fixed actions, horizon negative | working tree | passed | Exact dtype/shape/values, simulator-state and camera fingerprints; zero fixture agrees with official loop |
| Shared-runtime real VLA protocol control | working tree | passed | Same compiled model, fresh key-0 streams; inputs, full predicted chunks and native trace agree exactly |
| Independent GPU process bitwise rollout | working tree | failed | Both paths succeed but full predicted chunks differ |
| Official-path cross-process repeatability | working tree | failed | Identical first inputs give different first chunks; low-level cause not isolated |
| Reproductions before review fixes | 6ad872c + tests | passed | Different CPU budgets accepted in both job modes; default reference verification raised KeyError |
| Store/planning/consolidation regressions | working tree | passed | Synthetic Runs and terminal-record fixtures; budget dimensions reject pairing/consolidation without mutation; equivalent effective timeout stays paired |
| Real saved-evidence CPU rescore | working tree | passed | Prior model and calibration evidence verified/scored without inline reference or inference; artifacts and history kept |
| Real native consolidation/rescore | working tree | passed | Disposable zero-action calibration; version-2 Run identity, two consolidations, CPU rescore; cleanup and lease release |
| Full-suite statistical equivalence | working tree | not_run | Sampled protocol checks do not establish it |

## Next / open issues
Independent-process bitwise repeatability is not established; the passing control does not erase that failure. Full-suite equivalence and later-episode stream parity are untested. Full Web creation remains deferred.
