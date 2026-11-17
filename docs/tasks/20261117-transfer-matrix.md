# V5: transfer evidence matrix
branch: feat/transfer-matrix · status: completed · updated: 2026-11-17

## Goal
Expose saved cross-environment bundle assessments through a read-only API, CLI and Web matrix, retaining condition compatibility and missing evidence without aggregate scores.

## Changes
- Added shared contracts and a pure projection of immutable E3 records. No new persisted entity, report backfill, report selection or execution path.
- Rows identify exact parent/child bundles; columns separate benchmark/version, Agent/model, frozen execution/resource conditions, task files/sets, metric and assessment role. Missing/incompatible evidence has no estimate; repeated assessments retain their selected report revisions and policies.
- Added `orbit bench transfer`, `GET /bench/transfer` and Configurations → Transfer matrix, with URL filters/selection, resource details and links to archived gate evidence. Display differences are raw child−parent; saved verdicts retain their original one-sided tests.
- Updated design, plan, status, both README progress tables and the [usage guide](../guides/transfer-matrix.md). Formal V4 and second-Agent evidence remain pending.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Targeted projection / HTTP / CLI | V5 tree on dd5e1a9 | passed | Synthetic scores, real gate/Store/client/routes; version/resource isolation, rescores, metric direction, missing coverage, archived job deletion and read-only behavior |
| Web rendering / routing / API | V5 tree on dd5e1a9 | passed | Missing and incompatible estimates, repeated records, archived links, cancellation and configuration navigation |
| Chromium interactions | V5 tree on dd5e1a9 | passed | Explicit synthetic HTTP data; keyboard selection, reload, bundle filters, missing/error/retry states and narrow light-theme layout; script in `packages/web/test/browser/transfer.ts` |
| `pnpm verify` | V5 tree on dd5e1a9 | passed | 1,225 tests passed, 32 optional integration checks skipped; format/types/boundaries/Python syntax and both builds passed; isolated development Python dependencies used |
| New Docker / Agent / effect study | V5 tree on dd5e1a9 | not_run | Read-only presentation change; no execution/auth lifecycle changes or model evaluations required |

## Next / open issues
- Ready for review on the task branch; merge and push only when requested.
- The matrix includes saved gate selections only. V4 offline study results and separate Orbit homes are not automatically imported or pooled; formal comparisons and second-Agent validation remain future work.
