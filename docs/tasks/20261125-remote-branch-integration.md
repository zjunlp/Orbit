# Integrate pending remote branches

branch: fix/merge-remote-20261125 · status: completed · updated: 2026-11-25

## Goal

Integrate the pending embodied and Web/API fixes into main, preserving their commits and
verifying their combined behavior before updating the remote and local main branches.

## Changes

- Merge PR #11 and PRs #13–#21 on top of the npm 0.2.0 release, without merge conflicts.
- Wait for list data before restoring scroll position; slow loads must not exhaust the retry window.
- Account for benchmark job/trial cells spanning three table columns when hiding narrow-screen
  columns, so their duration stays visible.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Source PR CI | Original PR heads | passed | All ten source PRs have successful CI runs. |
| `pnpm test:embodied-sdk` with system Python | Integration tree | failed | Missing CI dependencies; rerun below uses the existing Python 3.11 CI environment. |
| `pnpm test:embodied-sdk` | Integration tree | passed | 197 tests, one declared skip. |
| `pnpm verify` | Integration tree | passed | 49 script, 1,040 core and 180 Web tests passed; 32 declared core skips. Formatting, types, boundaries and builds passed with existing size/bundling warnings. |
| `pnpm smoke:package` | Integration tree | passed | Installed tarball, native adapter executable permission, CLI/exports, isolated daemon HTTP, Web/assets/licenses; doctor passed 19 real checks. |
| Real Docker command-account integration | Integration tree | passed | Two real Docker tests; private daemon, non-root execution, independent verifier and confirmed cleanup. |
| Web regression tests and formatting | Integration tree | passed | Four test files, seven tests; changed Web files pass Biome. |
| Chromium responsive table check | Integration tree | passed | Static layout fixture reproduces hidden durations before the fix; corrected run/job/trial rows stay visible without table overflow at five widths. Not a live daemon UI check. |
| Full GPU benchmark rerun | Integration tree | not_run | Existing source-branch real validation is retained; this integration adds bounded Docker and package checks, not a new model evaluation. |

## Next / open issues

- Upstream embodied validation limits remain: fresh dependency image installation and full-suite
  performance are not established by this integration. Regenerate shared native adapter registrations
  and RoboTwin sample plans when adopting the updated evaluator.
