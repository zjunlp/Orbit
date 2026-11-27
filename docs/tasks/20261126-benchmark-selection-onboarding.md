# Benchmark selection and Web onboarding
branch: feat/bench-selection-web-onboarding · status: completed · updated: 2026-11-26

## Goal

- Compare up to four benchmark families by protocol, support scope, verification evidence and local setup facts.
- Preserve the selected families in the URL across discovery filters without introducing score rankings.
- Generate teaching templates explicitly from the Web through the existing daemon init endpoint.

## Changes

- Web URL selection keeps up to four families across filters; comparison separates protocol profiles, support scope, evidence and local registrations.
- Web onboarding validates inputs, previews tutorial files, prevents duplicate submissions and presents explicit post-creation commands.
- Added an opt-in real daemon/browser validation script; no mocked HTTP, registrations, Docker jobs or model calls.
- Reuse existing product catalog and POST /bench/init; no automatic registration or execution.

## Validation

Baseline: `f3cc945`; results apply to the working changes on this branch.

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Full `pnpm verify` | working tree | passed | Biome checked 600 files; types, boundaries and build passed; 49 script + 1054 Orbit + 191 Web = 1294 tests passed, 32 opt-in skipped |
| Synthetic comparison browser checks | working tree | passed | Explicit HTTP fixtures: URL selection across filters, profiles, refresh/back/forward, four-family limit, unknown IDs, clear, keyboard and 390px horizontal scrolling |
| Synthetic onboarding browser checks | working tree | passed | Explicit HTTP fixtures: deliberate submit, duplicate-submit guard, error retry, success focus, leave/reenter with late responses, and no paths in URL/localStorage |
| Real daemon/browser template generation and comparison | working tree | passed | Actual daemon/resource probe and built Web, no HTTP mocks: adapter/manifest files and next-step commands verified; duplicate directory rejected without replacing the original definition; two real catalog families matched names, descriptions and protocol profiles; registrations/jobs/runs all zero |
| Docker task and model execution | working tree | not_run | This round changes UI selection and explicit tutorial-file generation, so no execution is needed; previous template execution checks are recorded separately |
| Independent code review | working tree | passed | No actionable findings after reviewing URL/profile selection, comparison facts, input validation, daemon write reuse and retry behavior |
| Live script Biome and Web TypeScript | working tree | passed | Verification harness formatting and package typecheck |

Reproduce the opt-in real check after building; it creates isolated temporary home/data, retains
its own screenshots and validation report, and closes only its browser and daemon:

```sh
pnpm build
ORBIT_CHROMIUM_PATH=/path/to/chromium node packages/web/test/browser/benchmark-onboarding-live.ts
```

Previous real Docker template calibration: [20261125 discovery and onboarding](20261125-benchmark-discovery-onboarding.md).

## Next / open issues

- Tutorial generation does not establish real benchmark, Agent/model or upstream full-suite validation.
