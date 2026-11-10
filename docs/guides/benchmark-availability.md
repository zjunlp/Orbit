# Comparison-table benchmark availability

This tracks original evaluation protocols, not substitute benchmarks or leaderboard scores.
The implemented product routes are in the [catalog](../catalog.md). Register source checkouts and
licensed data outside Orbit's repository. Model credentials do not grant dataset or grader access.

| Benchmark named in the comparison | Orbit route and remaining condition |
| --- | --- |
| FrontierCode 2.0 | No public task bundle/evaluator verified. [Cognition's benchmark description](https://cognition.com/frontiercode) is insufficient to build a faithful executable adapter. Obtain the original private package. |
| FrontierSWE v2 | [Pinned Harbor adapter](../../examples/bench-adapters/harbor-suites/). Preserves task accounts, original images, independent verifiers and phase-specific GPU model requirements. Allowlist-as-public remains a recorded deviation; individual unavailable/unsupported tasks stay visible. |
| AutomationBench | [Native adapter](../../examples/bench-adapters/automationbench/) for the 600 public and separate 200 simple tasks. The private leaderboard split is not included. |
| Terminal-Bench-Science 0.1 | Existing Harbor route. Checked scientific tasks do not establish parity with every numbered release or the comparison's full protocol. |
| CyScenarioBench | The original [Irregular evaluation](https://www.irregular.com/research/cyscenariobench) is proprietary. No faithful task/evaluator package available for registration. |
| CVE Rediscovery | An internal evaluation in the [Anthropic release description](https://www.anthropic.com/claude-fable-and-mythos-5-2). Public CVE data alone does not reproduce its task selection, environment or success criteria. |
| De novo binder design (24 hr) | Requires the original targets, design/assay workflow and success rubric. A generic protein-design dataset is a different benchmark. Original executable evaluation unavailable. |
| WANDR (relaxed score) | [Pinned Harbor adapter](../../examples/bench-adapters/harbor-suites/) retains `soft_recall_full` and all twelve original metrics. Nonempty scoring needs original judge and page-fetch services. |
| OSWorld 2.1 | Existing [OSWorld-V2 adapter](../../examples/bench-adapters/osworld-v2/) retains release catalogs. Authorized task assets, VM images and real KVM calibration are required. |
| RoboDojo Sim | Native work is tracked separately; it is not supplied by this integration branch. Do not equate other robotics environments with RoboDojo. |
| AA-Briefcase v1.1 | [Artificial Analysis](https://artificialanalysis.ai/articles/aa-briefcase) keeps the scored suite private. Its Lite examples do not provide a replacement for the original scored task set. |
| Remote Labor Index (RLI) | The [public evaluation platform](https://github.com/centerforaisafety/rli_evaluation_platform) supports human assessment. An automated score cannot be substituted for that process; original task data and the human evaluation workflow are needed. |
| Humanity's Last Exam (with tools) | The public [cais/hle dataset](https://huggingface.co/datasets/cais/hle) can be loaded through Hugging Face Datasets; an Orbit tool-enabled adapter is not implemented. Current upstream [tool instructions](https://github.com/centerforaisafety/hle/blob/main/docs/evaluation-with-tools.md) target HLE-Diamond and require an offline code sandbox, filtered web tools, pinned packages and provider harness conditions. Do not equate the public HLE split, HLE-Diamond and the comparison's protocol without verifying their dataset and harness identities. |
| Chartography (no tools) | [Native Inspect adapter](../../examples/bench-adapters/chartography/) accepts original local task packs. Real model and alternate-judge checks passed on a public dummy sample; released data and default-judge calibration remain pending. The two public dummy examples are development-only. |

Private or unavailable suites are not added to the supported product catalog as runnable
placeholders. A pending calibration label means code exists but the stated real validation is still
outstanding. Successful transport/authentication, mock judges and loading examples are not evidence
of benchmark accuracy or leaderboard equivalence.
