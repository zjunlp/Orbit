# Remaining benchmark integrations
branch: feat/remaining-benchmarks · status: completed · updated: 2026-11-16

## Goal

Integrate remaining requested families, preserving native inputs, evaluation and prerequisites.
Validate three or four original tasks per runnable family. Keep data and runtime evidence outside Git.

## Changes

- Pinned native adapters: HealthBench, LongMemEval, FinanceBench, AgentDojo v1.2.2 clean utility, SWE-bench 3.0.15 Lite, AppWorld 0.1.3.post1 public train/dev and miniF2F Lean 3.
- Shared private question staging, dataset/source integrity, bounded native judge transport and failure handling.
- FinanceBench full-document and evidence-context conditions; exact published human labels and explicit review import.
- AgentDojo isolated tool service and fresh-environment native replay; offline reference/empty checks are separate.
- SWE-bench uses installed official instance images and the original test scripts/report parser, with harness dependencies isolated from repository tests.
- AppWorld public train/dev uses original safety guards and task-success evaluation; miniF2F fixes the original statements and checks exported dependencies with native leanchecker.
- Product catalog routes, resource defaults, synthetic failure/privacy tests and real Run/Method contract checks.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Previous task reconciliation | 27fed5a | passed | Existing LegalBench, LawBench and MMAU retained. |
| Synthetic adapters and contract tests | working tree over b40bb2a | passed | Explicit fixtures, not native parity or model evaluation; import timeout stays an infrastructure failure. |
| First four native Docker checks | f787c3d | passed | Four original tasks each; repeated reference/empty for memory and utility, both FinanceBench contexts; empty only for HealthBench. |
| First four saved-evidence rescores | f787c3d | passed | Original evidence retained; repeated native results unchanged on sampled controls. |
| SWE-bench and AppWorld native checks and rescores | b40bb2a and working tree | passed | Four original tasks each; two repetitions; reference and empty controls; saved-evidence results unchanged. |
| miniF2F native Docker checks | working tree over b40bb2a | passed | Four original theorems; two repetitions of reference/empty controls; submitted sorry proof receives zero. |
| miniF2F saved-evidence rescore | working tree over b40bb2a | passed | All sixteen results unchanged; execution, evaluation and cleanup checked separately. |
| Full pnpm verify | working tree over b40bb2a | passed | Format, lint, types, boundaries, tests and build. |
| AgentDojo live service setup | f787c3d | failed | Infrastructure setup failed before subject actions; offline native replay checks are separate. |
| AppWorld live service check | b40bb2a | not_run | Same unresolved Docker network allocation prerequisite. |
| Official judge and full-suite equivalence | working tree over b40bb2a | not_run | Alternative judge configuration and bounded controls only. |

## Next / open issues

- Judge-backed checks use an explicit alternative model/transport; official judge models and full-suite parity remain unverified.
- HealthBench nonempty model answers remain unverified; its raw mean differs from the official clipped aggregate.
- AgentDojo and AppWorld live service execution and real model quality remain unverified; retry after Docker network allocation is available.
- New FinanceBench answers require human review. Reference replay does not assess new model quality.
- ToolSandbox is not integrated: native user simulation requires a working OpenAI simulator configuration; some scenarios also require RapidAPI. No substitute user was introduced.
- MedAgentBench is not integrated: the separately distributed original refsol grader is unavailable. Native FHIR service validation is also required. No substitute grader was introduced.
