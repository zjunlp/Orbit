# Integrate embodied expansion, ATIF converters and trial evidence views
branch: refactor/integrate-branches-20261113 · status: completed · updated: 2026-11-13

## Goal

Integrate the completed native embodied expansion, ATIF T1 converters and trial evidence views
into one verified revision, preserving their execution and evidence boundaries.

## Changes

- Merge PR #8 (`feat/embodied-eval`), `feat/atif-trajectory` and `feat/trial-evidence-shapes`.
  Git found no textual conflicts. Preserve the benchmark/policy directory migration alongside
  verifier-generated episode indexes and TextArena service-record imports.
- Reject Claude native timestamps that violate the ATIF datetime contract, retaining usable
  messages with explicit truncation diagnostics. Add regression coverage for four invalid forms.
- Reconcile current documentation: 43 product catalogue families, ATIF T1 complete with T2
  still separate, and the new episode/conversation review coverage.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| PR #8 CI | d458d8a | passed | Remote CI on the exact merged PR head |
| ATIF and existing session tests | integration working tree | passed | 62 tests, including invalid timestamps and native-shaped synthetic fixtures |
| `pnpm verify` | integration working tree | passed | 813 Orbit, 129 Web and 5 script tests; 28 opt-in tests skipped; format, lint, types, boundaries and build passed |
| Package smoke | integration working tree | passed | Installed package CLI/npx, exports/types, daemon HTTP, Web, assets and licences |
| Affected embodied SDK modules | integration working tree | passed | 85 passed, one optional official RoboDojo checkout check skipped; synthetic simulator fixtures and real loopback transport are distinguished |
| All adapter test directories | integration working tree | passed | 19 directories, 209 passed and 13 optional dependency/source skips |
| Saved RoboDojo/RoboLab CPU verification | integration working tree | passed | Current staged verifier in real runtime images, solve evidence read-only; unchanged verdicts, schema-valid timelines below 2 MiB, cleanup done and leases released |
| New GPU/Policy rollout and Python 3.8 suite | — | not_run | No new simulator behavior in the integration fix; prior feature checks remain scoped to their records, this host regression used Python 3.10 |

## Next / open issues

- ATIF Run storage/API/CLI remains separate T2 work. The legacy Python archive is historical,
  not a replacement for the current TypeScript product.
- New solves require benchmark registrations generated against the updated SDK implementation
  digest; saved evidence retains its original solve digest for CPU verification.
