# Independent policy and native embodied benchmarks
branch: feat/embodied-eval · status: completed · updated: 2026-11-06

## Goal

Implement the reviewed C6 design incrementally: lock the OpenPI LIBERO reference (D0), then
run one planned episode through independent policy and benchmark endpoints (D1). Preserve
legacy adapters, trial identities, reports and the existing Run/resource lifecycle.

## Changes

- Add daemon-owned independent policy registration, HTTP/client/CLI entry points and frozen
  policy, semantic binding and ordered sample-plan snapshots. Reuse existing services, resource
  leases, Run lifecycle and store; no second scheduler or state ledger.
- Preserve required legacy seeds and report fingerprints. Planned trials use sampleRef without
  seed, report v2, sample-aware comparison/consolidation and basic Web review. Report identity
  includes the complete model/runtime snapshot, benchmark registration and binding.
- Add a Python 3.8+ SDK and direct official LIBERO/OpenPI path without vla-eval. Record native
  verdicts, requested chunks, executed actions, initial states and optional video. Separate
  CPU-only verification supports rescore from sealed solve evidence. Archive both implementations.
- Pin upstream source inputs, checkpoint and normalization content; provide audit, image build,
  local registration generation and sample-planning tools. Calibration fixtures are explicitly
  marked and excluded from the real-model catalog. Local configs and runtime assets stay outside Git.
- Fix GPU-mode detection: prefer NVIDIA CDI only in directories Docker reports as enabled.
  An installed spec with CDI disabled uses the existing legacy GPU flag; bounded query failures
  also use that path. No host Docker configuration changes are required.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Source/checkpoint/image audit | working tree | passed | Pinned upstream commits and files; full content fingerprints and immutable runtime images |
| `pnpm verify` | working tree | passed | Node 24: lint/types/boundaries, 5 script + 598 Orbit + 69 Web tests, builds; 26 existing skips |
| Docker CDI detection regression | working tree | passed | Enabled NVIDIA directory, disabled/missing CDI, malformed response and query failure; real GPU run uses the supported legacy path |
| Python 3.8 / 3.11 SDK checks | working tree | passed | 17 checks in each environment; synthetic endpoints, real WebSocket transport, evidence corruption and implementation archive |
| Real Docker / LIBERO negative checks | working tree | passed | Explicit stateless calibration fixture; two native initial states; valid horizon failures and cleanup |
| Single-sample rescore | working tree | passed | No new solve; selected trial history updates, other trial unchanged; verify has no model/simulator |
| Restart / implementation archives | working tree | passed | Daemon restart preserves jobs; new verifier accepts saved positive and negative evidence; solve source bundle remains intact |
| Real VLA positive | working tree | passed | Official pinned π₀.₅ weights, CPU model service and native LIBERO success; separate roles, verification and cleanup |
| GPU VLA positive | working tree | passed | Same pinned weights and planned sample; CUDA required; observed model process on leased GPU, main role has no GPU; native success, independent verify and cleanup |
| Official reference parity / full suite | working tree | not_run | Requires aligned random streams and the subsequent comparison phase |

## Next / open issues

D0 source/content lock and the D1 episode path are implemented and checked. D2a will add shared solve batches,
sample ownership, migration/backup recovery and verifier cost measurements; D2b adds a second
endpoint family and validated direct mapping. Full Web creation and C6 calibration selection
remain deferred. D3 compares deterministic processing, fixed-action environments and aligned
random rollouts separately. Resource inventories and personal run records stay outside Git.
