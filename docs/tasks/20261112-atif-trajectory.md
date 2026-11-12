# ATIF contract and native Agent trajectory converters
branch: feat/atif-trajectory · status: completed · updated: 2026-11-12

## Goal
Complete T1: validated ATIF trajectories from native Codex and Claude Code sessions, with paired
tools, traceable usage and explicit incomplete evidence. Keep native sessions as the source of truth.

## Changes
- Strict ATIF v1.5–v1.8 read contract, v1.7 output and Orbit provenance extensions; upstream reference:
  Harbor RFC 0001 and trajectory models at `feea734`.
- Pure native JSONL converters, source hashes, tool/result pairing, usage deduplication, compaction,
  opaque reasoning, media assets and Claude branch/sidechain handling.
- Existing transcript consumers stay compatible; lifecycle, HTTP/CLI and view migration remain T2.
- Sanitized native-shaped golden fixtures and targeted regression tests; fixture contents are synthetic
  replacements for private messages, tool arguments, answers, IDs and paths.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| ATIF contract tests | T1 working tree | passed | Version, strict fields, references, steps, media and nullable upstream fields |
| Native converter regression tests | T1 final working tree | passed | 51 ATIF tests: strict contracts, native goldens, usage, media, parallel tools, compaction, active branches and subagent provenance |
| Real native sessions + Harbor 0.25.0 validator | T1 working tree | passed | One retained Run per CLI; same-step tool/result pairing and token totals match each CLI's native accounting; media materialized outside checkout |
| pnpm verify | T1 final working tree | passed | 806 Orbit, 125 Web and 5 script tests; 28 opt-in tests skipped; format, types, boundaries and builds passed; existing large HTML/chunk warnings remain |
| New Docker/GPU/Agent execution | — | not_run | Read-only conversion of retained real Run evidence; no execution or isolation changes |

## Next / open issues
- T1 complete. Three additional retained host sessions checked parallel tool pairing, native token totals and compaction; broken source ancestry remains explicitly truncated.
- T2 generates and stores trajectories, rebuilds old runs and exposes API/CLI.
- Codex conversion accepts one rollout; discovery/aggregation of child rollouts is not implemented.
