# RoboTwin 2.0 Clean and Randomized suites
branch: feat/embodied-eval · status: completed · updated: 2026-11-08

## Goal
Expose the 50 upstream Aloha-AgileX tasks in each official RoboTwin 2.0 evaluation suite.

## Changes
- Register Clean and Randomized with separate frozen suite files, task horizons, native task code and asset digests. Keep the original single-task registration and checkpoint.
- Assemble the complete object assets for both suites and the unseen evaluation textures for Randomized.
- Freeze the first expert-accepted scene seeds from the upstream candidate stream for each selected task. Recheck the seeds at solve time and aggregate valid results by task.
- Pass fresh native clutter bounds at each randomized reset. The upstream function applies task table offsets in place, so shared defaults would change later scenes.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Pinned source, assets and catalogs | working tree | passed | Both registrations list the same 50 upstream tasks and produce a pinned solve specification. The pinned object tree covers all referenced object directory names. Randomized includes all 1,000 unseen textures. |
| Python SDK | working tree | passed | 84 tests on each of Python 3.8 and 3.11, including synthetic suite registration, accepted-seed planning and independent clutter bounds. |
| Native setup, three cameras, control and verdict | working tree | passed | 50 tasks per suite. Randomized cameras showed spatial variation, and native scenes used the pinned unseen textures. Both tasks with nonzero table offsets passed under the fresh-bounds shim. |
| Native expert seed plan | working tree | passed | The planner emitted two Clean and one Randomized expert-accepted `adjust_bottle` sample from the official seed stream. The generated sample and plan digests match the frozen registration. |
| Expert-dependent verdict state | working tree | passed | `open_laptop`, `place_object_scale` and `put_object_cabinet` passed the full expert, reset and control path in both suites. The first cabinet candidate failed in both the direct native expert and Orbit. Published cabinet seeds 53 (Clean) and 184 (Randomized) passed native evaluation and Orbit's recheck. [Upstream expert issue](https://github.com/RoboTwin-Platform/RoboTwin/pull/529) |
| Full-suite model scores | working tree | not_run | The existing real model acceptance covers the single-task Clean recipe. |

## Next / open issues
- Whole-suite policy scores and statistical equivalence require separate evaluation runs.
