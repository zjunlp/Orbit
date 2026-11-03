# GUI benchmark infrastructure research
branch: docs/gui-bench-research · status: completed · updated: 2026-11-03

## Goal
Document six GUI evaluation infrastructure projects from fixed public source revisions, including evaluation, scheduling, recovery, artifacts and Web interfaces.

## Changes
- Add six Chinese source-grounded research reports and a comparison index under `docs/research/gui-bench/`.
- Distinguish benchmark registrations, external adapters, static grounding, task subsets and implementation versus runtime validation.
- Include 85 commit-pinned source links and separate design recommendations from implemented behavior.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Report structure, internal links and source paths | documentation working tree | passed | Six reports, one index; 85 source paths match seven pinned repository revisions |
| CUA-Lite MobileWorld task subset | upstream 2af69268 | passed | Static task-catalog count confirms 201 total, 161 registered, 44 user-interaction, 117 default GUI-only |
| pnpm verify | documentation working tree | passed | Format, lint, types, boundaries, tests and build completed |
| Upstream environments, model evaluations and Web UI execution | pinned upstream revisions | not_run | Source research only; no runtime deployment |

## Next / open issues
Documentation is complete. Runtime benchmark verification and product integration remain outside this task.
