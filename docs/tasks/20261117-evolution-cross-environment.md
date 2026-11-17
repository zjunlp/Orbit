# V4: cross-environment study tools
branch: feat/evolution-cross-environment · status: completed · updated: 2026-11-17

## Goal
Implement prospective two-arm study tooling and a bounded real Codex workflow preview. Formal effect estimation and a second Agent are deferred by user scope.

## Changes
- Freeze balanced chain plans, E1 partitions, editor/evaluation conditions and global/chain/final budgets; reject incomplete selected-task resource templates before a new freeze.
- Capture existing API records, retain failed/retried model calls, replay E3 verdicts and reconstruct accept-only chains with evolve-only provenance.
- Require all chains closed before final evaluation; report original-metric paired task intervals, coverage, explicit reuse, incompatible/unrun cells and unknown costs without imputation.
- Require independent homes for formal chain histories. Research results and execution notes remain outside Git; no daemon loop, state store or new execution path.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Study regression checks | V4 tree, base 2ea5268 | passed | 13 synthetic checks: freeze, budgets, history, acceptance/rejection, leakage, final timing, coverage, unknown costs and resource templates |
| pnpm verify | V4 tree | passed | Format/lint/types/boundaries, 1,203 tests and builds; 32 opt-in integration tests skipped; existing isolated Python dependencies |
| Real editor / target workflow | V4 tree | passed | Genuine isolated Codex edit, V3 collection, evolve smoke, parent target evaluation and prospective budget stop; no promotion |
| Real API capture / offline analysis | V4 tree | passed | Captured actual job/report/Run evidence; distinguished planned/started chains, invalid/incompatible cells, unrun cells and unknown usage |
| Terminal benchmark connectivity | Preview controller | failed | Multiple network addresses were concatenated in the temporary model-proxy allowlist; failed Runs preserved, missing usage blocks further submissions |
| Non-model connectivity diagnostic | Corrected preview controller | passed | Real multi-network Docker Run with separate allowed addresses reached HTTPS; no Agent/model call |
| Resource condition enforcement | V4 tree | passed | Real old-template mismatch quarantined without score comparison; new freezes reject missing selected-task overrides |
| Cleanup | V4 tree | passed | Own Runs cleaned, no active leases or remaining labelled containers, temporary proxy closed and private daemon stopped |
| Full comparison / second Agent / Claude | — | not_run | User deferred formal runs and second Agent; no further Claude checks requested |

## Next / open issues
- The bounded preview stopped early and did not complete a two-arm comparison. It establishes workflow/error handling, not evolution effects.
- Before formal execution, prepare complete resource templates and separate chain homes, verify model connectivity, and freeze a new adequately sized study. Preserve prior costs and failed evidence.
- Token caps remain post-Run checks; unknown usage blocks submission. Statistical intervals condition on an endpoint, not independent-chain causal effects. V5 transfer API/Web remains separate.
