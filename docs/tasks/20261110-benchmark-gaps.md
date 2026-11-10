# Native benchmark integrations and availability
branch: feat/benchmark-gap-integrations · status: blocked · updated: 2026-11-10

## Goal
Connect the available original benchmark protocols from the comparison table through Orbit's existing execution and scoring paths. Expose unavailable originals and incomplete validation explicitly.

## Changes
- Add native AutomationBench public/simple registrations, its original tool agent and independent rubric over saved world state.
- Add pinned FrontierSWE v2 / WANDR wrappers over Harbor: complete catalog identities, incomplete-source detection, native invalid markers, twelve WANDR metrics and original oracle flags.
- Preserve Harbor's task account through a shared `commandUser` contract, CLI and Web support. Keep root initialization and independent verification separate; use native tar artifact exclusions.
- Ensure explicitly passed model/judge variables override adapter defaults only in their intended phase.
- Add Chartography's original Inspect no-tools solver, sample-pack fingerprints and independent original scorer. Dummy examples and alternate judges remain explicit evaluation conditions.
- Expand the product library from 24 to 28 families and document all 14 entries in the [availability matrix](../guides/benchmark-availability.md). Sources, credentials and evaluation outputs remain outside Git.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | working tree | passed | Format, lint, types, boundaries, 723 core tests, 103 Web tests, 5 script tests and builds; 28 opt-in tests skipped. The opt-in account tests also run separately with real Docker. |
| Check after build | working tree | passed | No generated declaration files leak into external adapter sources. |
| Real Docker command account and credential phases | working tree | passed | Dedicated private-daemon checks; non-root main cannot read root data, outputs remain readable, independent verifier retains its account, grader secret absent from main. |
| AutomationBench native development checks | working tree | passed | Original catalogs, empty world, real compatible-provider rollout, independent original-rubric agreement and bounded valid failure checked. No fake model or replacement grader. |
| FrontierSWE native development checks | working tree | passed | Original empty/reference controls and real Claude Code auth under the task account; reference and empty rescoring also passed with native tar exclusions. Public networking is an explicit deviation from upstream allowlisting. |
| Chartography native development checks | working tree | passed | Complete bench flow on an original dummy sample with real vision generation and an explicitly alternate real model judge; empty/reference controls and malformed mock-judge rejection checked. Adapter verifies saved response identity. |
| WANDR native empty calibration | bd0024b | passed | Original environment and grader returned a valid empty score with all twelve native metrics. Ordinary container networking, saved after-phase evidence and cleanup checked. No judge service or mock grader used. |
| Released/full-suite protocol parity | working tree | not_run | Missing private packages, restricted datasets, judge/fetch services or original tool environments as documented in the matrix. |

## Next / open issues
- WANDR nonempty grading and model calibration still require original judge/fetch services; empty calibration does not establish model or full-suite parity.
- Obtain released Chartography data and default judge access; HLE additionally needs its restricted web/code harness. Do not replace either protocol with an unrestricted CLI.
- Private FrontierCode, CyScenarioBench, CVE Rediscovery, binder-design and AA-Briefcase evaluations require their original executable packages. RLI requires its original human assessment workflow.
- OSWorld retains its existing asset/KVM calibration requirement. RoboDojo is being developed in a separate branch and is not included here.
