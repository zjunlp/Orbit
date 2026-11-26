# Benchmark registration review
branch: feat/bench-registration-review · status: completed · updated: 2026-11-26

## Goal

- Check a custom benchmark JSON definition and review listing coverage before registration.
- Require explicit create-only registration and preserve existing registrations on name conflicts.
- Connect Web tutorial creation, uploaded/pasted definitions, review and registration without starting jobs.

## Changes

- Shared registration-check contract/API, guarded create-only registration, CLI check/create-only flags and Web definition review flow.
- Opt-in real daemon/built-Web script covers CLI check, pasted/uploaded definitions, explicit registration and name conflicts.
- Preserve family-specific resource preparation and existing execution paths.

## Validation

Baseline: `af4f8c3`; results describe the working changes on this branch.

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Focused registration tests | working tree | passed | 3 backend + 3 Web tests |
| Independent code review | working tree | passed | No actionable findings in current backend/API/CLI and Web input, review invalidation, late response and conflict handling |
| Live-script Biome and Web TypeScript | working tree | passed | Harness formatting and package typecheck |
| Full `pnpm verify` | working tree | passed | Biome checked 607 files; types, boundaries and build passed; 49 script + 1058 Orbit + 194 Web = 1301 tests passed, 32 opt-in skipped |
| Real daemon/built-Web registration | working tree | passed | Actual CLI check and browser paste/upload for adapter/manifest, real task listing and no HTTP mocks; check leaves registry/jobs/runs empty; explicit registration creates one matching definition per isolated scenario; existing-name check and different-path create-only rejection preserve the registration; jobs/runs remain zero |
| Synthetic browser and onboarding regression | working tree | passed | Explicit HTTP fixtures: inputs, slow file/check responses, conflicts, explicit handoff, focus and 390px layout |
| Docker/model evaluation | working tree | not_run | This round checks and registers definitions without running evaluations; earlier template Docker checks have a separate record |

Reproduce the opt-in real check with an installed Chromium executable:

```sh
pnpm build
ORBIT_CHROMIUM_PATH=/path/to/chromium node packages/web/test/browser/benchmark-registration-live.ts
```

The harness supplies the actual CLI as daemon `self` for built-in manifest task listing, uses
isolated temporary home/data, retains its own validation artifacts and closes its browser/daemon.
Earlier Docker template checks: [discovery/onboarding](20261125-benchmark-discovery-onboarding.md).

## Next / open issues

- Listing/check success is not benchmark calibration or upstream scoring equivalence.
