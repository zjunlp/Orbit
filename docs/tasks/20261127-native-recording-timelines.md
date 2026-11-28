# Basic native episode timelines

branch: feat/embodied-eval · status: completed · updated: 2026-11-27

## Goal

Generate basic review timelines from saved native control records and finalized videos.

## Changes

- The shared single-camera recorders and the CALVIN and VLABench recorders report their output path, camera and frame rate. The driver publishes the description with the captured frame count after closing the video.
- Verify uses that description to align the video. A known control rate also supports a numerical timeline when media is unavailable. Actions use numbered channels when the frozen profile lacks names.
- LIBERO-PRO uses the LIBERO timeline format.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | Working tree | passed | Full verification on a local SSD checkout with the working-tree changes. |
| Archived native episodes through CPU Verify | Working tree | passed | Replayed both RoboCasa365 camera variants, VLA-Arena and LIBERO-PRO. Matched saved verdicts and compared the index against actual MP4 frame counts and rates. The Web contract accepted the resulting indexes. |
| CALVIN and VLABench archives through CPU Verify | Working tree | passed | Compared control steps and video timestamps with the MP4s. Saved verdicts matched, and the Web contract accepted the video and numeric-only indexes. |
| Python 3.11 SDK | Working tree | passed | 202 passed and one skipped. |
| Python 3.8 focused SDK tests | Working tree | passed | 41 passed for the shared recorder change. The trajectory and batch suites passed all 24 tests after adding CALVIN and VLABench. |
| Python 3.8 full SDK suite | Working tree | failed | The RoboDojo configurator uses `Path.is_relative_to`. The same error reproduced at baseline `975e7f45`. |
| New simulator rollouts | Working tree | not_run | Validation replayed recorded simulator output and exercised recorder hooks in focused fixtures. |

## Next / open issues

Refresh existing native benchmark definitions when deploying the updated shared adapter. Policy build recipes that check the full SDK digest also require a matching image when rerunning those configurators.
