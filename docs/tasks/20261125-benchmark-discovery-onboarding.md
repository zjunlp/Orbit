# Benchmark discovery and onboarding
branch: feat/bench-discovery-onboarding · status: completed · updated: 2026-11-25

## Goal

- Make existing benchmark families discoverable through CLI and a concise Web library.
- Explain supported protocol profiles, verification scope and local setup facts separately.
- Generate safe, reviewable teaching templates for new adapter or manifest integrations.

## Changes

- CLI catalog uses the existing client/API and taxonomy vocabulary; filters require a single matching profile, with stable `{ supported, entries }` JSON.
- Web library adds shareable discovery/setup filters and profile details, with memoized derived data.
- Daemon-backed init generates CPU synthetic templates and next-step commands in a new directory; no registration or run is started.
- Added onboarding guide and linked discovery, resource preparation, four integration routes and calibration limits.

## Validation

Baseline: `08163f5`; results below apply to the working changes on this branch.

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Catalog CLI unit/command tests | working tree | passed | 11 tests: same-profile conjunction, repeated-field OR, invalid filters, search, JSON envelope and explicit local associations |
| Catalog CLI Biome | working tree | passed | New CLI module and tests |
| Orbit TypeScript | working tree | passed | Package typecheck |
| Module boundaries | working tree | passed | CLI uses client/contracts only |
| Initial `pnpm verify` | working tree | failed | Existing embodied Python suite lacked the websockets dependency; rerun with the CI requirements environment pending |
| Full `pnpm verify` rerun | working tree | passed | requirements-ci.txt dependencies in an isolated venv; format, lint, types, boundaries, tests and build passed; 49 script + 1054 Orbit + 183 Web = 1286 tests passed, 32 opt-in skipped |
| Real Docker adapter and manifest tutorial calibration | working tree | passed | Each: 1 task × empty/oracle × 2 seeds; actual daemon, CLI and Docker in isolated temporary home/data, no fakes; both phase done and calibrated=true |
| Tutorial calibration evidence | working tree | passed | All seven checks: finished, valid, empty=0, oracle=1, repeat consistency, cleanup/lease release, and 4/4 rescore consistency |
| Web tests, TypeScript and Biome | working tree | passed | 183 tests, package typecheck and formatting/lint checks |
| Chromium browser validation | working tree | passed | Explicit synthetic HTTP fixture; keyboard, URL restoration, protocol profiles, clearing setup filters and 390px viewport |
| Final task-resource cleanup | working tree | passed | Task-specific Docker containers/networks/volumes all zero; ledger leases and queued runs zero; temporary daemon stopped |
| New-template real Agent/model check | working tree | not_run | CPU empty/oracle controls were the scope; no model credentials were connected |

## Next / open issues

- Synthetic tutorial checks do not establish real benchmark support, upstream scoring equivalence, real Agent/model operation or full-suite statistical equivalence.
- Browser checks used an explicit synthetic HTTP fixture; new-template real Agent/model checks were outside the CPU-control validation scope.
