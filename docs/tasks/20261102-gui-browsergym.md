# GUI phase one: BrowserGym / MiniWoB
branch: feat/gui-browsergym · status: completed · updated: 2026-11-02

## Goal
Run external GUI policies through the existing Run/Trial lifecycle, preserve original live rewards and reviewable observations.

## Changes
- Add external Method entrypoint/config and solve-only environment forwarding; keep CLI auth/bundles separate and unsupported built-ins explicit.
- Add a pinned BrowserGym/MiniWoB Docker adapter for five tasks, screenshot/bid observation modes and original live grading.
- Save screenshots, actions and rewards for existing Trial review; rescore validates captured evidence, not reconstructed browser state.
- Document custom policy factories, calibration, resource defaults and phase-one limits.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Adapter unit checks | working tree | passed | 11 explicit filesystem-fixture checks; no BrowserGym execution |
| Orbit regression tests | working tree | passed | 381 tests; 17 opt-in Docker tests skipped |
| Orbit/Web types | working tree | passed | Shared Method contract reaches daemon/client/CLI/Web |
| Initial full repository verification | working tree | failed | Unchanged snapshot test intermittently omitted a same-size file edit; focused unrestricted rerun passed (restricted rerun could not spawn Git) |
| Full repository verification | working tree | passed | Format/lint/types/boundaries/tests/build; 381 Orbit + 26 Web + 5 tooling tests; 17 opt-in Docker tests skipped |
| BrowserGym image build | working tree | passed | Initial PyPI downloads failed/timed out; pinned dependencies built through a public mirror; Chromium runs as Orbit's non-root user |
| Initial GUI Docker check | working tree | failed | Test waited for job instead of trial completion during rescore; corrected the test helper to match the existing API |
| Real BrowserGym Docker checks | working tree | passed | 3 tests: five original empty tasks, scripted positive calibration, injected policy ConnectionError, solve/verifier variable separation, PNG/trajectory capture, saved-evidence rescore, cancellation and confirmed container/lease cleanup |
| Real VLM provider execution | working tree | not_run | Calibration uses a scripted policy; no model API or performance claim |

## Next / open issues
- Connect a real VLM policy and expand task coverage after this integration baseline.
- General VLM execution, desktop/Android environments, GUI checkpoint/replay and GPU policies are outside this phase.
