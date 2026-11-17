# Unified trajectory and evolution review (T6/E5)
branch: feat/run-trajectory · status: completed · updated: 2026-11-16

## Goal
Make ATIF steps, environment evidence and immutable evolution verdicts reviewable in Web.

## Changes
- Merged origin/feat/embodied-eval at d1fd7cd in 4d4eff3; retained evolution contracts and records.
- Run/Trial trajectory review reads ATIF with virtual navigation, embedded sub-Agents, tools, usage, compression/checkpoint markers and safe local media; submitter sessions remain accessible.
- Reused GUI, episode and conversation viewers with explicit step alignment. Shared batches retain the selected Trial identity; missing or historical attempts never substitute newer environment evidence. Environment-only review remains available.
- Configurations show lineage verdicts and saved-record history. Details expose prerequisites, performance/guard/cost checks, bounds, alpha, frozen policy/reports and leakage exclusions; A/A remains separate from promotion.
- Regressed-task comparisons pair samples from frozen reports and load their recorded solve Runs. Missing Runs preserve report evidence; changing tasks/attempts clears stale trajectory content.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Initial merge verification | 4d4eff3 | failed | Adapter suite initially lacked its documented CI Python dependencies |
| Merge adapter retest | 4d4eff3 | passed | Installed examples/sdk/requirements-ci.txt in an isolated environment; 25 adapter tests passed |
| pnpm verify | 4d4eff3 + T6/E5 | passed | Format, lint, types, boundaries, scripts 9, core 923, Web 149 and both builds; 32 opt-in integration tests skipped |
| Browser: existing real evidence | 4d4eff3 + T6/E5 | passed | Saved gate history/filter, A/A identity, frozen parent/child solve trajectories, URL/keyboard navigation, task switching during a held request and mobile layouts |
| Browser: explicit synthetic fixtures | 4d4eff3 + T6/E5 | passed | 5,000 steps mounted 16 navigation rows; embedded child; all three environment kinds; shared-batch identity; unlinked steps; ATIF failure; changed/deleted solve attempts |
| New real Agent/Docker/GPU execution | 4d4eff3 + T6/E5 | not_run | UI changes read retained real records; controlled environment fixtures are not benchmark reruns. Claude execution omitted as requested |

## Next / open issues
- Checkpoint restore/fork remains F2/F3; this view only marks recorded checkpoints.
- Gate history displays up to 100 newest records with an exact child filter; it does not select a current winner.
- T6/E5 are complete on the task branch; no main merge or push was performed in this task.
