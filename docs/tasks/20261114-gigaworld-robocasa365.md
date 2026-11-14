# GigaWorld-Policy-0.1 on native RoboCasa365

branch: feat/embodied-eval · status: completed · updated: 2026-11-14

## Goal

Run the released GigaWorld-Policy-0.1 checkpoint as an independent policy on RoboCasa365.

## Changes

- Generate Target50 and three task-group registrations with the release's 1.5× horizon and success stop.
- Preserve the T-layout camera recipe and convert LeRobot action order into RoboCasa365 order.
- Verify the fixed 20-step replanning schedule from the saved controls.
- Follow the upstream constructor and reset for sample zero. Use independently derived reset seeds for later samples.
- Accept the release's initial Torch seed of 42 in the custom WebSocket policy contract.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Catalog and plan expansion | working tree | passed | Expanded 50 tasks into 2,500 frozen samples. |
| Offline runtime | working tree | passed | Built the image and loaded the released VAE, UMT5 and Wan transformer. Camera latent and text embedding were finite. |
| Native fixed-control comparison | working tree | passed | Reset state and first control agreed on a frozen sample. RGB repeats differed by at most one intensity level in fewer than 0.05% of values. |
| Channel-order regression | working tree | passed | Checks the camera names, 16D state order, 24 × 12 action permutation and rejection of non-finite output. |
| Closed-loop solve and CPU rescore | working tree | passed | The released checkpoint restored all transformer keys. The native driver ran through the 1,350-step horizon with finite 24 × 12 chunks. CPU verification and rescore agreed. |
| Full-suite model evaluation | working tree | not_run | Closed-loop validation used one frozen sample. |
