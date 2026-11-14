# EB-Navigation policy input review
branch: feat/embodied-eval · status: completed · updated: 2026-11-14

## Goal

Show the annotated policy input in the Trial timeline and cover SeeNav's episode state in regression tests.

## Changes

- Record the pre-action `navigation_views` image as a third synchronized video. Historical evidence indexes the recordings it contains.
- Run CPU tests against the pinned planner during the policy image build. A synthetic model checks image assembly, action parsing and fallback, feedback and episode reset.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Policy image | SeeNav matched profile | passed | Three tests use the pinned planner and synthetic model responses. The asset check also passes. |
| Real SeeNav episode | Three-view recording | passed | Native rollout, CPU verification and rescore agree. All three H.264 streams have one frame per action at 5 FPS. Both verifier indexes parse with the Web reader and seek to the same timestamps. |
| Historical recording | Two-view evidence | passed | The new indexer exposes both original videos from a saved real episode. |
| Repository and SDK | Working tree | passed | `pnpm verify` and Python 3.8/3.11 regression checks. |
