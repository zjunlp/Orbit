# Preserve Git snapshot race detection
branch: fix/snapshot-index-race · status: completed · updated: 2026-11-03

## Goal
Prevent snapshot metadata from omitting same-size tracked edits when file timestamps match Git's cached stat data.

## Changes
- Copy the original index timestamp along with its contents, reading the timestamp before copying. A newly dated copy otherwise disables Git's racily-clean content check.
- Start a fresh temporary index only when the original is missing; fail on copy/timestamp errors instead of producing incomplete metadata.
- Add deterministic regressions for ordinary and linked worktrees with matching timestamps and coarse stat configuration, using real Git. Preserve original index bytes/mtime and object storage.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| New regressions before fix | a715d61 + tests | failed | Both repository layouts omitted the tracked edit as expected |
| Snapshot tests | feature tree | passed | All 9 checks; real temporary Git repositories, no Docker/GPU execution |
| `pnpm verify` | feature tree | passed | 456 tests, types, boundaries and builds; 17 opt-in integration tests skipped; four pre-existing lint warnings |

## Next / open issues
- No known open implementation issues. This preserves Git's existing race detection, not an atomic snapshot of concurrently edited files.
