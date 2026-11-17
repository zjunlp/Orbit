# Native adapter review fixes
branch: fix/review-remaining-benchmarks · status: completed · updated: 2026-11-17

## Goal

Fix CLI model access and SWE-bench catalog association before merging the additional adapters.

## Changes

- Enable CLI solve networking for LegalBench, LawBench, HealthBench, LongMemEval, FinanceBench,
  SWE-bench and miniF2F. Keep empty/reference controls offline and preserve verifier policies.
- Use `swebench` consistently for the adapter, product catalog and resource preparation identity.
- Exercise real Method/Run conversion and adapter-derived catalog association using explicit
  synthetic fixtures. Include Codex, Claude Code and supported empty/reference controls.
- Integrate current main before verification.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Regression before fix | 4d2b861 plus current main | failed | All seven CLI network cases reproduced the bug. |
| Regression after fix | working tree over cb3a60f | passed | Seven adapter cases cover Codex/Claude networking, offline controls and adapter-derived catalog association. |
| Real Codex startup | working tree | failed | Host command wrapper referred to a path absent in the container; model access was not exercised. Cleanup completed. |
| Real Claude Code transport | working tree | passed | Real model response to a synthetic arithmetic prompt, output assertion, confirmed cleanup and lease release. Not native benchmark parity. |
| Full `pnpm verify` | working tree | passed | 18 script, 991 core and 158 Web tests; 32 opt-in integration tests skipped. Checks and builds passed. |
| Installed package smoke | working tree | passed | CLI, exports, daemon HTTP, Web, all 62 preparation entries and packaged adapters. |

## Next / open issues

Codex model transport remains unverified because of the existing host wrapper configuration;
Claude Code provides the real transport check. Full native benchmark/model quality evaluations
are outside this targeted fix.
