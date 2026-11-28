# Basic native episode timelines

branch: feat/embodied-eval · status: completed · updated: 2026-11-28

## Goal

Generate basic review timelines from saved native control records and finalized videos.

## Changes

- The shared single-camera recorders and the CALVIN and VLABench recorders report their output path, camera and frame rate. The driver publishes the description with the captured frame count after closing the video.
- Verify uses that description to align the video. A known control rate also supports a numerical timeline when media is unavailable. Actions use numbered channels when the frozen profile lacks names.
- LIBERO-PRO uses the LIBERO timeline format.
- The driver records the stop cause supplied by the adapter. Replay distinguishes control limits from native or policy stops, including when either happens on the final allowed step.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | Working tree | passed | Full verification on a local SSD checkout with the working-tree changes. |
| Archived native episodes through CPU Verify | Working tree | passed | Replayed both RoboCasa365 camera variants, VLA-Arena and LIBERO-PRO. Matched saved verdicts and compared the index against actual MP4 frame counts and rates. The Web contract accepted the resulting indexes. |
| CALVIN and VLABench archives through CPU Verify | Working tree | passed | Compared control steps and video timestamps with the MP4s. Saved verdicts matched, and the Web contract accepted the video and numeric-only indexes. |
| Python 3.11 SDK | Working tree | passed | 202 passed and one skipped. |
| Python 3.8 focused SDK tests | Working tree | passed | 41 passed for the shared recorder change. The trajectory and batch suites passed all 24 tests after adding CALVIN and VLABench. |
| Python 3.8 full SDK suite | Working tree | failed | The RoboDojo configurator uses `Path.is_relative_to`. The same error reproduced at baseline `975e7f45`. |
| VIMA-Bench and CLIPort CPU simulation | Stop-cause follow-up | passed | Scripted control pairs distinguished the step limit from the simulator's action timeout. Both used a deliberately obstructed end effector to trigger the timeout and passed evidence verification. |
| Stop-cause replay and verification | Stop-cause follow-up | passed | Real BiGym timeout remained truncated. Archive-backed synthetic CHORES and VLA-Arena controls verified that an explicit stop or physical completion can terminate a failed episode. |
| Python SDK | Stop-cause follow-up | passed | Full Python 3.11 suite and focused Python 3.8 suite covered recorded stop causes, archived fallback, and the driver cap with a native stop flag. |

## Next / open issues

Refresh existing native benchmark definitions when deploying the updated shared adapter. Policy build recipes that check the full SDK digest also require a matching image when rerunning those configurators.
