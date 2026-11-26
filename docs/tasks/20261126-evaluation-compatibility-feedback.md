# Evaluation compatibility feedback
branch: feat/evaluation-compatibility-feedback · status: completed · updated: 2026-11-26

## Goal

- Fetch current admission facts for the selected benchmark before evaluation submission.
- Show known capability/auth blockers in configuration and review while keeping unknown checks distinct.
- Preserve evaluation drafts and ignore stale responses when switching or refreshing environments.

## Changes

- Targeted compatibility API uses current listing facts with benchmark/time provenance and existing capability/auth rules.
- New Evaluation configuration/review shows blockers, filters credential kinds and preserves drafts on environment refresh.
- Opt-in real HTTP/checker/built-Web script uses explicit synthetic listing, Agent and placeholder credential metadata without executing them.
- Legacy compatibility matrix and final submit validation remain in place.
- Surface task-listing refresh errors in configuration/review when Continue or submission is disabled.
- Inject the daemon’s shared Agent registry into BenchService so custom registrations are visible consistently to compatibility, catalogs and submission.

## Validation

Baseline: `4b24a7b`; results apply to the working changes on this branch.

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Focused tests | working tree | passed | Backend compatibility 1 test and Web new-job 20 tests |
| Independent review | working tree | passed | Review and real checks identified shared Agent registry injection and missing configuration/review task-error feedback; both corrected |
| Live script Biome | working tree | passed | Explicit synthetic fixture metadata; real task enumeration and HTTP |
| Initial `pnpm verify` | working tree | failed | Initial browser-script typecheck failed; corrected before the next run |
| Initial real daemon/built-Web check | working tree | failed | Exposed missing shared Agent registry injection: custom Agent was visible through /agents but not BenchService; corrected and covered by regression |
| Final `pnpm verify` | working tree | passed | 49 script + 1061 Orbit + 199 Web = 1309 tests passed, 32 opt-in skipped; format, lint, types, boundaries and build passed |
| Final-build real daemon/built-Web check | working tree | passed | Real HTTP, resource probe, task enumeration and checker with explicit synthetic listing/Agent/placeholder auth; blocked→allowed after listing edit, checked provenance, unknown/error distinct; UI blocks Continue then refresh restores admission; registry unchanged, jobs/runs/submit POST all zero |
| Synthetic browser interactions | working tree | passed | Explicit HTTP fixtures: mobile/keyboard, late responses, old/missing marker, selected credential kind; configuration/review tasks 503 with targeted allowed shows error, disables action and preserves drafts through recovery |
| Docker/GPU/model execution | working tree | not_run | Validation inspects declarations/admission only; synthetic Agent and placeholder credentials are never executed |

Reproduce the opt-in real check:

```sh
pnpm build
ORBIT_CHROMIUM_PATH=/path/to/chromium node packages/web/test/browser/evaluation-compatibility-live.ts
```

The harness uses isolated temporary home/data and explicit actual CLI self-discovery, retains its
own screenshots/report, and closes only its browser/daemon. The custom Agent fixture was retained through the registry fix.

## Next / open issues


- Admission feedback does not establish runtime availability, model capability or benchmark calibration.
