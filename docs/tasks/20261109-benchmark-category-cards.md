# Benchmark dimensions and homepage discovery

branch: fix/benchmark-category-cards · status: completed · updated: 2026-11-09

## Goal

Make the homepage and benchmark filters explain six independent dimensions with controlled values,
and remove historical C1–C7 coverage from public product discovery.

## Changes

- Replace numbered filter cards with prominent icons, category names, persistent descriptions and selected-value badges; preserve the existing taxonomy and matching rules.
- Persist the open dimension in the URL so homepage category and value links open the matching filters; keyboard activation and close-focus restoration remain available.
- Align Overview with the product library while separating local registrations and evaluation evidence.
- Update current design, catalog and guides; mark old category proposals and overview as historical.
  Keep compatibility identifiers, original research observations and historical validation facts intact.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Documentation links, vocabulary and status limit | working tree | passed | 98 added local link occurrences resolve; all 11 field counts match the source vocabulary and six groups; status is 40 lines; documentation whitespace check passed. |
| `pnpm verify` | working tree | passed | Format, types, boundaries, tests and builds passed: scripts 5, Orbit 715, Web 106; 26 opt-in tests skipped, 9 existing lint warnings. |
| Browser review | working tree | passed | Real catalog read-only checks: six homepage/filter cards, dimension links and value counts, keyboard/focus, URL reload and 390/768/1280/1590 px light/dark layouts without overflow or page errors. Explicit synthetic API error/empty-local fixtures verify retry and discovery before setup. |
| Real Docker/GPU evaluation | working tree | not_run | Discovery UI and documentation only; no execution change. |

## Next / open issues

- Native Policy discovery and incomplete taxonomy annotations remain separate work; no metadata is inferred from legacy categories.
- Historical C1–C7 references remain only in compatibility or clearly marked historical context;
  they neither assign six-dimensional values nor establish capability coverage.
