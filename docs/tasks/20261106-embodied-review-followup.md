# Consolidation budgets and default reference consistency
branch: feat/embodied-eval · status: completed · updated: 2026-11-06

## Goal

Reject consolidation of different frozen execution budgets and support the same pinned default
reference during listing, solve planning, verification and scoring.

## Changes

- Reuse effective budget normalization from report identity and pairing for each adopted existing
  task, including retained invalid retries. Transport aliases do not bypass budget checks.
- Keep the job timeout's precedence and preserve source budgets for appended tasks. Reject
  mismatches before changing records, ownership or artifacts, in both legacy and planned jobs.
- Resolve explicit/default reference content through one digest-checked function. Verifying old
  evidence still does not require its original adapter implementation to remain current.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Reproductions before fixes | 6ad872c + regression tests | passed | Different CPU budgets were accepted in both job modes; default reference verification raised KeyError |
| Python 3.8 / 3.11 SDK checks | working tree | passed | 27 each; default/explicit reference agreement and rejection of default-content drift |
| `pnpm verify` | working tree | passed | 5 script + 620 Orbit + 69 Web tests; 26 existing skips; lint/types/boundaries/build passed |
| Consolidation regression with terminal-record fixtures | working tree | passed | All five budget dimensions, both job modes, preview/apply rejection without mutation; equivalent effective timeout, unrelated task budgets and appended task budgets retained |
| Pinned source planning and CPU saved-evidence verification without inline reference | working tree | passed | Real task listing/solve planning; version-1 model and version-2 calibration evidence verified/scored in isolated CPU Runs, no model inference; cleanup done and leases released |

## Next / open issues

Independent-process numerical repeatability and full-suite statistical equivalence are unchanged
and were not rerun for these fixes. Generated registrations continue to embed reference content;
omitted references remain pinned by profileDigest and reject changed packaged content.
