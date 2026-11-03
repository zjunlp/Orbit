# GUI benchmark Web workflow
branch: feat/gui-bench-web · status: completed · updated: 2026-11-03

## Goal
Make registered GUI evaluations runnable and reviewable through the existing Bench workflow, using English UI and Orbit's existing visual style.

## Changes
- Add optional benchmark capabilities and saved registration settings, used across execution, recovery, rescoring and consolidation.
- Add English evaluation creation/copying, task/result filters, progress, and arbitrary method baselines using the existing metrics and themes.
- Add versioned GUI review artifacts with verified action/frame correspondence; keep saved-evidence checks separate from new Agent execution and retain legacy/non-GUI review.
- Adapt Trial and Job headers to narrow screens; load selected comparison conditions independently of the capped job list.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | final feature tree | passed | Format, lint, types, boundaries, 454 tests and both builds; 17 opt-in integration tests skipped; four pre-existing lint warnings |
| Python adapter unit tests | feature tree | passed | 13 tests; disposable fixtures |
| BrowserGym Docker integration | feature tree | passed | 3 tests using real Chromium: empty/scripted policies, injected provider error, trajectory, evidence recheck and cancellation |
| Chromium Web workflow | final feature tree | passed | Real isolated daemon: create evaluation, filter valid zero, before/after frames, recheck, baseline/filter selection; desktop, light theme, 768/390 px review |
| Earlier verification attempts | feature tree | failed | Restricted process execution and a corrected formatting issue; one unchanged snapshot test intermittently omitted a same-size tracked edit. Focused 7-test rerun and final full verification passed; cause not proven |
| General VLM policy evaluation | feature tree | not_run | Validation used explicit scripted/empty policies; no model calls |

## Next / open issues
- The later main-branch CI reproduced the snapshot issue; see the [index timestamp fix](20261103-snapshot-index-race.md).
- Live streaming, GUI state restoration, and multi-user accounts remain outside this change.
