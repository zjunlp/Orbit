# LingBot-VA on native RoboTwin 2.0 Clean

branch: feat/embodied-eval · status: completed · updated: 2026-11-13

## Goal

Run the released RoboTwin checkpoint with native Cartesian control and observation feedback to the world model.

## Changes

- Register the 50 Clean tasks with the upstream `seen` instruction pool and native end-effector targets.
- Execute 16 controls after the initial query and 32 thereafter. Send camera keyframes every four controls and update the upstream model using the preceding raw prediction.
- Reset the upstream model cache and pose anchor per episode. Independently verify the recorded chunk boundaries and native stop.
- Limit Torch CPU threads to the policy service's CPU allocation for offloaded text and video encoding.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Policy image | working tree | passed | Built and imported the pinned server in the offline image. |
| Native catalog | working tree | passed | Orbit returned all 50 Clean task IDs. |
| Native simulator | working tree | passed | GPU expert precheck, Cartesian reset, sixteen native controls and the first camera history boundary. |
| Cache protocol regression | working tree | passed | Synthetic predictions exercised four- and eight-keyframe updates and two consecutive episode resets. |
| Upstream action conversion | working tree | passed | Compared a fixed two-frame prediction against the pinned client's pose composition. |
| Closed-loop model | working tree | passed | Two expert-accepted Clean scenes ran in one GPU batch. The service reset before both episodes, and independent CPU verification and rescore agreed. |
| Full-suite model evaluation | working tree | not_run | Validation used two frozen scenes of one task. |
