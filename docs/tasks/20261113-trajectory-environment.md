# Environment trajectory alignment
branch: feat/run-trajectory · status: completed · updated: 2026-11-13

## Goal
Complete T4 on the existing branch: link GUI, embodied and conversation evidence to root ATIF
steps while retaining legacy records and independent evaluation results.

## Changes
- Session messages carry step IDs; environment records use sessionStepIds scoped to sessionRunId.
- Read-time alignment reuses safe local/worker artifact and ATIF paths; original files stay unchanged.
- GUI action IDs, EFE step references/legacy indexes and exact or unique conversation calls.
- CLI and Web reviews share linked records, including Verify files referencing Solve sessions.
- Missing sessions remain environment-only; damaged evidence stays viewable with a truncation marker.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Environment integration | T4 working tree | passed | 9 tests; real store/converters/HTTP handlers; transport, worker and scheduler doubles explicit |
| Converter/lifecycle regressions | T4 working tree | passed | 58 tests |
| Web regressions | T4 working tree | passed | 136 Web tests, including stable GUI/Episode/Conversation references and legacy rendering |
| pnpm verify | T4 working tree | passed | 840 core + 136 Web + 5 script tests; 28 opt-in tests skipped; types, boundaries and builds passed |
| New live environment/Agent jobs | T4 working tree | not_run | Evidence alignment only; disposable MiniWoB/EFE/BFCL-format fixtures cover calibrated formats, no simulator or model launched |

## Next / open issues
- T4 is kept on this feature branch. T5 is the next package.
- References currently address root ATIF steps. Ambiguous calls and subagent-local steps remain unlinked.
