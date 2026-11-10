# Evaluation configurations in the Web UI

branch: fix/evaluation-configurations · status: completed · updated: 2026-11-10

## Goal

Name the existing evaluated settings accurately. Independent Methods have not been designed;
model, reasoning-effort and setup changes are configuration versions.

## Changes

- Rename the navigation, homepage, configuration history, evaluation forms, comparisons and
  trial actions to evaluation configurations. Replace method-evolution and lineage language
  with configuration comparisons, source versions and notes.
- Use `/configurations`; preserve saved `/methods` URLs with their query and anchor.
  Keep the existing API, payload fields, CLI syntax, stored names and evaluation behavior.
- Keep configuration reuse, version summaries and comparisons under matching conditions.
  Update current product documentation and mark the earlier Methods proposal as historical.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | working tree | passed | Format, lint, types, boundaries, tests and builds: 829 passed, 26 opt-in skipped; 9 existing lint warnings. |
| Documentation checks | working tree | passed | Local file links resolve; status remains 40 lines; current terminology and historical annotations checked. |
| Browser review | working tree | passed | Preview and served production assets: homepage/navigation, saved URL filters and anchors, reload, configuration history, copy wizard preserving model/effort/source, and 390/1280 px layouts. Explicit synthetic empty-state response; no page errors or API writes. |
| Real Docker/GPU evaluation | working tree | not_run | UI terminology and compatible navigation only; no execution changes. |

## Next / open issues

An independent Method definition and lifecycle remain future design. Existing protocol names remain compatibility fields.
