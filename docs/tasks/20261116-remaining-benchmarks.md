# Remaining benchmark integrations
branch: feat/remaining-benchmarks · status: in_progress · updated: 2026-11-16

## Goal

Integrate remaining requested families, preserving native inputs, evaluation and prerequisites.
Validate three or four original tasks per runnable family. Keep data and runtime evidence outside Git.

## Changes

- Pinned native adapters: HealthBench, LongMemEval, FinanceBench, AgentDojo v1.2.2 clean utility, SWE-bench 3.0.15 Lite and AppWorld 0.1.3.post1 public train/dev.
- Shared private question staging, dataset/source integrity, bounded native judge transport and failure handling.
- FinanceBench full-document and evidence-context conditions; exact published human labels and explicit review import.
- AgentDojo isolated tool service and fresh-environment native replay; offline reference/empty checks are separate.
- Product catalog routes, resource defaults, synthetic failure/privacy tests and real Run/Method contract checks.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Previous task reconciliation | 27fed5a | passed | Existing LegalBench, LawBench and MMAU retained. |
| Synthetic adapters and contract tests | working tree over 27fed5a | passed | Explicit fixtures, not native parity or model evaluation. |
| Native Docker checks | working tree over 27fed5a | passed | Four original tasks each; repeated reference/empty for memory and utility, both FinanceBench contexts; empty only for HealthBench. |
| Saved-evidence rescore | working tree over 27fed5a | passed | Four families; original evidence retained, repeated native scores unchanged on sampled controls. |
| Full pnpm verify | f787c3d and working tree over f787c3d | passed | Format, lint, types, boundaries, tests and build. |
| SWE-bench and AppWorld native checks | working tree over f787c3d | passed | Four original tasks each; two repetitions; reference and empty controls. |

## Next / open issues

- SWE-bench and AppWorld each passed four original tasks with reference/empty controls and two repetitions; live AppWorld services and real model quality remain unverified.

- Judge-backed checks use an explicit alternative model/transport; official judge models and full-suite parity remain unverified.
- HealthBench nonempty model answers remain unverified; its raw mean differs from the official clipped aggregate.
- AgentDojo live service execution remains unverified; infrastructure setup failed before any subject action.
- New FinanceBench answers require human review. Reference replay does not assess new model quality.
- Continue ToolSandbox, MedAgentBench and miniF2F where prerequisites permit; ToolSandbox live tool dependencies, MedAgentBench refsol and miniF2F Lean 3 cache need separate validation.
- Review staged diffs and commit substantive integrations. Do not push.
