# Xiaomi-Robotics-1 on native RoboCasa365

branch: feat/embodied-eval · status: completed · updated: 2026-11-14

## Goal

Run the released Xiaomi-Robotics-1 checkpoint as an independent policy on RoboCasa365.

## Changes

- Generate Target50 and three task-group registrations with frozen reset seeds.
- Preserve the strided three-camera observation history, native horizon and Gymnasium stopping flags.
- Verify the fixed 16-step replanning schedule from the saved controls.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Catalog and plan expansion | working tree | passed | Expanded 50 tasks into 2,500 frozen samples. |
| Policy image and offline processor | working tree | passed | Built the image and loaded the released processor in an isolated container. |
| Native fixed-control comparison | working tree | passed | Reset state, history padding and first control agreed on a frozen sample. RGB repeats differed by at most one intensity level in fewer than 0.05% of values. |
| Closed-loop solve and CPU rescore | working tree | passed | Ran the released checkpoint through the 900-step horizon. Validated the 16 × 12 chunks, native result and saved score independently on CPU. |
| Full-suite model evaluation | working tree | not_run | Closed-loop validation used one frozen sample. |
