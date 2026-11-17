# Expanded benchmark catalog merge
branch: feat/remaining-benchmarks · status: completed · updated: 2026-11-17

## Goal

Merge main into the benchmark integration branch while preserving both catalogs, validation
coverage and the existing native adapter boundaries.

## Changes

- Resolve catalog, import, documentation and test conflicts; retain all 62 benchmark families.
- Preserve main's resource preparation design section and give the additional adapters a distinct section.
- Add guided setup and existing-definition import entries for the ten additional families.
  Automatic acquisition/configuration for these entries remains unimplemented; incomplete
  setup stays pending and imports retain native runtime and grading settings.
- Keep the existing daemon validation and registration path; add explicit fixture checks for
  pending setup and configuration-preserving imports across all ten entries.
- Update installed-package smoke expectations and check that all ten adapters are bundled.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Catalog and preparation discovery | merge working tree | passed | Both expose 62 entries with no duplicate family IDs. |
| Full `pnpm verify` | merge working tree | passed | 9 script, 978 core and 157 Web tests; 32 opt-in core tests skipped. Node 24, existing CI Python environment and one BLAS thread. Format, lint, types, boundaries and both builds passed. |
| Native preparation regression fixtures | merge working tree | passed | All ten additional entries remain pending without setup and preserve imported configuration. These are explicit fixtures, not native benchmark evaluations. |
| Installed npm package smoke | merge working tree | passed | Installed outside the source tree; all 62 recipes exposed, all ten adapter assets present; CLI, exports, daemon HTTP, Web and licenses checked. |
| New real model/Docker benchmark evaluation | merge working tree | not_run | Merge changes catalog/preparation guidance, not adapter execution; previous sampled checks are recorded with the original features. |

## Next / open issues

- Local merge only; no push is part of this change.
- Automatic preparation of the additional native adapters remains future work.
