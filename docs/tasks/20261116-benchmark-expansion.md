# Benchmark expansion: LegalBench, LawBench and audio MMAU
branch: feat/benchmark-expansion · status: completed · updated: 2026-11-16

## Goal

Plan the twelve requested integrations and deliver the first feasible, verified adapters through
the existing protocol. Preserve upstream inputs, native grading, identities and unsupported-task
reasons. Check each implemented family on four tasks; samples do not establish suite parity.

## Changes

Implementation order and upstream prerequisites (a plan, not a support claim):

| Order | Benchmark / upstream | Approach and prerequisites |
| --- | --- | --- |
| 1 | [LegalBench](https://github.com/HazyResearch/legalbench) | Fixed dataset and native evaluation functions; expose only prompts to solve, labels to independent verify. |
| 2 | [LawBench](https://github.com/open-compass/LawBench) | Preserve task-specific native metrics and answer extraction; inventory all task types before declaring support. |
| 3 | [HealthBench](https://github.com/openai/simple-evals) | Native HealthBench rubric grader; requires a separately configured judge and official evaluation data. |
| 4 | [LongMemEval](https://github.com/xiaowu0162/LongMemEval) | Preserve timestamped histories and native category-specific QA judge; configure judge independently from the subject. |
| 5 | [FinanceBench](https://github.com/patronus-ai/financebench) | Public 150-question release, source documents and human grading. No published automatic grader; automated variants must be named explicitly. |
| 6 | [AgentDojo](https://github.com/ethz-spylab/agentdojo) | Native environment and utility/security checks; distinguish clean utility from attack/defense configurations. |
| 7 | [ToolSandbox](https://github.com/apple-aiml-research/ToolSandbox) | Native stateful tools, user simulation and milestone/minefield evaluators; trusted environment evidence required. |
| 8 | [AppWorld](https://github.com/StonyBrookNLP/appworld) | Native app APIs, task state and tests; official data installation and per-trial isolated state required. |
| 9 | [MedAgentBench](https://github.com/stanfordmlgroup/MedAgentBench) | Preserve the isolated FHIR service and native task evaluators; reference solutions require a separate official Box download. |
| 10 | [SWE-bench](https://github.com/SWE-bench/SWE-bench) | Native per-instance images and test harness; bounded image/disk requirements, patch-only submission. |
| 11 | [miniF2F](https://github.com/openai/miniF2F/tree/v1) | Fixed formal-system/toolchain variant; kernel checks must reject incomplete proofs and altered statements. |
| 12 | [MMAU](https://github.com/Sakshi113/MMAU) | Audio test-mini selected; audio-capable external subject and original answer evaluation. |

For each benchmark: study and pin upstream → implement adapter/resources/catalog/tests/README →
register through the daemon API → calibrate 3–4 tasks (empty plus reference where available) →
check saved-evidence rescore and cleanup → real Agent checks when credentials and protocol allow.
Reuse upstream graders; do not invent replacement metrics or present fixtures as real evaluations.
Datasets, images, runtime evidence, private judge configuration and batch notes stay outside Git.

Implemented: LegalBench whole-task native evaluation; LawBench zero-shot native functions;
MMAU original audio test-mini and string matcher, with a pinned Parquet-to-WAV preparation tool.
Source/data hashes are checked, reference answers stay private, and collected inputs protect
rescore. Shared SDK `batch.py` contains file-submission planning only. No core contract or
lifecycle changes. Each adapter includes resources, tests, Docker recipes, usage and catalog entry.

Exclusions remain explicit: LegalBench `rule_qa` needs human grading; LawBench `2-1` needs the
ChERRANT/LTP toolchain; missing assets stay visible as unsupported. MMAU requires an audio-capable
external method. LegalBench `sara_numeric` retains the upstream formula that cannot credit integer
predictions for zero references, and declares a partial oracle. LawBench preserves native ROUGE
epsilon and potentially negative distance metrics; no replacement metrics are introduced.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Source and existing adapter review | 5599484 | passed | No independent adapters for the twelve requested families in this revision. |
| Adapter unit tests | working tree over 5599484 | passed | 11 tests using explicit synthetic fixtures, including hidden labels, source drift, audio integrity and scorer errors. |
| LegalBench real Docker calibration | working tree over 5599484 | passed | hearsay, definition_extraction, sara_numeric, citation_prediction_open; empty/reference × two seeds; partial-oracle caveat above. |
| LawBench real Docker calibration | working tree over 5599484 | passed | 1-2, 2-3, 2-9, 3-7; empty/reference × two seeds; native ROUGE epsilon retained. |
| MMAU real Docker calibration | working tree over 5599484 | passed | Four original clips spanning sound, music and speech; empty/reference × two seeds; pinned HF bytes matched against original annotations. |
| Native grading / rescore / cleanup | working tree over 5599484 | passed | Each family: same-output native comparison, 16/16 saved-evidence rescores, repeatability, confirmed cleanup and lease release. |
| Real subject/model evaluation | — | not_run | No subject auth profile or audio model configured; oracle replay does not measure subject performance. |
| `pnpm verify` | working tree over 5599484 | passed | Isolated environment with repository CI Python dependencies; format, lint, types, boundaries, tests and build. Initial attempt failed because host Python lacked NumPy. |

## Next / open issues

The other nine families remain planned, not integrated. HealthBench and LongMemEval require a
separate configured judge for real grading. FinanceBench needs human grading or an explicitly
named alternative protocol. AgentDojo, ToolSandbox and AppWorld need native state/tool environment
isolation; MedAgentBench additionally needs the separately distributed reference module. SWE-bench
needs per-instance images and a disk budget; miniF2F needs a pinned formal-system/mathlib toolchain.
No placeholder catalog support is added for these prerequisites. Broader task coverage and real
subject evaluation remain separate follow-up work.
The external-method command contract and its regression coverage were corrected in the
[follow-up fix](20261116-batch-external-entrypoint.md); empty/reference calibration alone did not
exercise that path.
