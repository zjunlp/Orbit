# Run trajectory lifecycle and access
branch: feat/run-trajectory · status: completed · updated: 2026-11-13

## Goal
Complete T2 on top of T1: automatic ATIF storage, legacy backfill and rebuild, shared CLI/Web access,
and worker forwarding without changing execution or evaluation outcomes.

## Changes
- Run trajectory summaries; safe native/media reads, redacted atomic persistence and importer backups.
- Generate after execution cleanup; serialize per Run, preserve old documents on failure, record errors.
- HTTP/client/CLI access and worker forwarding; Session views project ATIF with explicit failure notices.
- Shared native discovery and decoding; checkpoint resume IDs remain available before any model turn.
- Design, status, usage guide and evolution-plan updates.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Targeted sessions, failures, cleanup and trajectories | T2 working tree | passed | Real stores/converters; scheduler, Docker and HTTP transport doubles explicit |
| Checkpoint compatibility | T2 working tree | passed | 10 regression tests; resume ID independent of ATIF steps |
| pnpm verify | T2 final working tree | passed | 815 core, 127 Web, 5 script tests; 28 opt-in tests skipped; format, types, boundaries and build passed |
| Real Docker bench lifecycle, CLI/Web HTTP and rebuild | T2 working tree | passed | Both native CLIs produced ATIF automatically on failed termination; CLI, Web fetch and stored files agree; importer backups retained; containers cleaned, leases released |
| Harbor 0.25.0 trajectory validator | Real generated ATIF | passed | Both automatically generated documents validate; no Python runtime dependency added |
| Real model solve | T2 working tree | failed | Existing Codex login expired; Claude request timed out; verifier network detach / Docker inspection also encountered environment errors; no successful solve claimed |
| Browser interaction | — | not_run | Web API used real HTTP; view rendering tested separately without a browser |
| Two physical nodes | — | not_run | Worker forwarding covered with in-process HTTP handlers |

## Next / open issues
- T2 complete on top of T1; local commit only, no merge/push.
- Existing large-HTML lint and Web chunk-size build warnings remain; opt-in Docker/GPU tests were not enabled.
- T3 token accounting and T4 environment alignment remain separate; Codex child-rollout aggregation remains T5 work.
