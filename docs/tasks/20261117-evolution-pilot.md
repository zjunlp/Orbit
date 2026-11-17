# Evolution pilot sizing (V0)
branch: feat/evolution-pilot · status: completed · updated: 2026-11-17

## Goal
Measure repeat noise, validity and solve cost through existing Orbit jobs, then freeze prospective gate inputs without exposing held-out tasks.

## Changes
- Read-only analysis of explicit immutable A/A records and E1 splits; replay and source/file/membership checks.
- Task-level flip uncertainty, invalid/unresolved coverage, complete versus partial solve costs and conditional first-round sizing.
- Keep all pilot artifacts outside Git; document frozen evolve-only sampling and insufficient family sizes.
- Add optional per-dataset metrics across gate evidence, CLI/API and Web; retain native report meaning and old-policy behavior.
- Share report cost extraction; optionally supplement missing costs from explicit finalized Run exports without editing immutable evidence.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Analysis and metric regressions | V0 tree, base defeae4 | passed | Synthetic evidence: uncertainty, invalid/unresolved coverage, missing/supplemental costs, source drift, held-out leakage and native metrics across CLI/API/Web |
| pnpm verify | V0 tree, base defeae4 | passed | Format, lint, types, boundaries, 1,135 tests and both builds; 32 opt-in integration tests skipped |
| Real repeated pilot | V0 tree, base defeae4 | passed | Actual Codex, original tool/GUI/game environments and independent scoring; real immutable A/A records, E1 splits and prospective policy; measurements outside Git |
| Finalized Run cost exports | V0 tree, base defeae4 | passed | Actual daemon exports explicitly supplement early shared-verifier reports; no report/decision rewritten |
| Shared-verifier rescore | V0 tree, base defeae4 | not_run | Existing API correctly refused a removed solve environment; no verifier or model rerun was substituted |
| Cleanup | V0 tree, base defeae4 | passed | Temporary connection helper cancelled; no active leases or task-labelled containers/networks/volumes |
| Claude / GPU execution | — | not_run | No further Claude testing requested; CPU-only pilot |

## Next / open issues
- V0 bounded execution is complete; family-wide power and sufficient formal guard populations are not established.
- Shared-verifier reports can precede final Run cost collection; explicit finalized snapshots supplement analysis without claiming complete historical report costs.
- V1 remains a separate work package; small guard populations can remain insufficient at the default margin.
