# Converge benchmark concepts and organize docs
branch: docs/converge-concepts · status: completed · updated: 2026-11-11

## Goal

Describe every benchmark with three concepts only: six-dimensional classification, integration
(method `harbor | manifest | sdk | native`, execution kind, concrete adapter) and the calibration
record. Retire the overlapping C1–C7 categories, L0/L1/L2 integration tiers, fidelity L0–L4 levels
and catalog verification grades from the docs, and give the docs a clear map.

## Changes

- `design.md`: new §9.10 defines the three concepts, the facts-only validation rule (calibration now,
  official-runner comparison later and optional) and the integration checklist kept from the retired
  category spec. §9.14 names integration methods instead of L0/L1/L2. Stale fidelity and category
  wording replaced across §3, §7, §9. Two appended English sections moved to §9.2a and §9.4b.
- Removed `overview.md` (2026-11-05 snapshot), `design-review.md` (review merged into design),
  `integration-categories.md` (C1–C7 spec) and `issue-userns-remap-bind-mounts.md`; the last became
  `guides/docker-userns-remap.md` without machine-specific details. All four remain in Git history.
- `status.md` rewritten with short lines; it records that contracts still carry the retired fields.
- New `docs/README.md` (docs map) and `docs/tasks/README.md` (topic index of all task records).
- `catalog.md`, guides, adapter READMEs/comments and two code comments updated to the new terms.
  READMEs link the docs map and the userns workaround. AGENTS.md asks new records and guides to be indexed.
- Code behavior unchanged: `category` still sets calibration defaults and `verification.level`
  remains in the catalog contract until a follow-up code change.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | branch head | passed | orbit 746 passed / 28 skipped, web 107 passed; includes the relative-link test over navigation docs |
| Real Docker / GPU / Agent | — | not_run | docs and comments only; no runtime behavior changed |

## Next / open issues

- Code: replace `category`-based calibration defaults with explicit `calibration`, drop
  `verification.level`, `CATEGORY_*` and the legacy `domains` vocabulary; stop accepting `category` in Harbor/manifest input.
- Detect `userns-remap` in `orbit doctor` / `--check`.
