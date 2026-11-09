# Supported benchmark library

branch: fix/benchmark-library · status: completed · updated: 2026-11-09

## Goal

Make Benchmarks show the benchmark families Orbit has adapted in each taxonomy category,
independently of local registrations and evaluation history. Clarify the separate role of VLA policies.

## Changes

- Add 24 source-controlled product families to the existing catalog response, retaining local entries.
- Show each benchmark family once; put integration routes, suites and recipes in its details.
- Preserve six-dimensional matching within one profile and distinguish integration validation scopes.
- Keep local registration editing and execution evidence in a separate view.
- Link registrations only through explicit identities, known native semantic profiles or supported
  CUA-Lite suites; unmatched setups remain available without creating duplicate registrations.
- Replace the outdated documentation catalog with an index to the shared product data and guides.
- Correct Policy documentation and record the remaining native Policy catalog gap in Agents.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| VLA support audit | working tree | passed | Cross-checked the compatibility guide, pinned model configurations, native adapters and development acceptance records. No private experiment data read. |
| Documentation and catalog consistency | working tree | passed | Product index matches 24 families; native scopes agree with pinned profiles and the compatibility matrix; local link targets exist, status is 40 lines and whitespace checks pass. Source catalog tests also validate its documentation links. |
| `pnpm verify` | working tree | passed | 823 tests passed (5 scripts, 715 Orbit, 103 Web); 26 opt-in tests skipped; 9 existing lint warnings. Formatting, types, boundaries and builds passed. |
| Browser review | working tree | passed | Six check groups with explicit synthetic fixtures and no page errors: 24 families with zero setups; 22 ASI registrations still produce one product card; six-dimensional filters, seven native families for robotics/manipulation and URL reload; matrix/search/pending-calibration filters; API retry; light/dark layouts at 390/768/1280/1512 px and mobile details without horizontal overflow. |
| Isolated built daemon HTTP | working tree | passed | A real built daemon with temporary home/data returned 24 product families and zero local registrations/jobs, and served built Web assets. It was stopped after the check; no model or GPU evaluation ran. |
| Real Docker/GPU evaluation | working tree | not_run | This change concerns catalog discovery and documentation; it adds no execution path. |

## Next / open issues

- Native VLA Policy discovery in Agents remains a separate frontend feature; the existing `/policies`
  API and Policy/Method contracts already support independent model registration.
