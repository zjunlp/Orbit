# Supported benchmark catalog

The Web **Benchmarks** library lists the benchmark families Orbit has adapters for, even when
the current machine has no registrations or evaluation history. A family appears once; its
integration routes, suites, recipes and validation limits appear in the details. Local registrations
remain a separate view, and execution history belongs in Evaluations and Runs.

The authoritative product data is [bench/supported.ts](../packages/orbit/src/bench/supported.ts),
with the shared response shape in [contracts/bench.ts](../packages/orbit/src/contracts/bench.ts).
The catalog currently contains 27 families. This document is a navigation index, not another
taxonomy or a machine-specific record. [Six dimensions](design.md#917-benchmark-六维分类-v12026-11-09)
· [Catalog contract and behavior](design.md#918-已适配-benchmark-产品目录2026-11-09)

| Area | Benchmark families | Setup and scope |
| --- | --- | --- |
| Code generation and terminal work | HumanEval; Terminal-Bench 4.0 | [HumanEval adapter](../examples/bench-adapters/humaneval/) · [Harbor support](tasks/20261010-harbor-verifier-modes.md) |
| Research and model development | ASI-Bench; LongDS-Bench; ResearchClawBench; PostTrainBench; Terminal-Bench Science | [ASI conditions](tasks/20261009-asi-runner-timeouts.md) · [LongDS adapter](../examples/bench-adapters/longds/) · [ResearchClawBench adapter](../examples/bench-adapters/researchclawbench/) · [Adapter protocol](tasks/20261003-bench-adapter-protocol.md) |
| Tools, user interaction and games | BFCL; τ²-bench; TextArena | [BFCL](tasks/20261105-sample-bfcl-multiturn.md) · [τ²-bench](tasks/20261105-sample-tau2.md) · [Game integration](tasks/20261105-samples-c1-c7.md) |
| Browser, desktop and mobile tasks | MiniWoB++; WebVoyager; Online-Mind2Web; Cua Bench; MobileWorld; OSWorld-V2 | [GUI guide](guides/gui-bench-web.md) · [CUA-Lite](../examples/bench-adapters/cua-lite/) · [Cua Bench](../examples/bench-adapters/cua-bench/) · [MobileWorld](../examples/bench-adapters/mobileworld/) · [OSWorld-V2](../examples/bench-adapters/osworld-v2/) |
| Embodied coding-agent tasks | Embodied First Exam | [EFE integration](tasks/20261104-p3-browsergym-efe.md) · [Execution boundaries](design.md#94-被评测对象agent-与-policy) |
| Native embodied policies | LIBERO, LIBERO-Plus, VLABench, SimplerEnv, RoboCasa v0.2, RoboCasa365, RoboTwin 2.0, ManiSkill3, Meta-World, CALVIN | [Native adapter](../examples/bench-adapters/embodied/) · [Compatibility matrix](guides/embodied-compatibility.md) · [Onboarding](guides/embodied-onboarding.md) |

The area column is a reading aid. The six-dimensional filters use the source catalog's explicit
profiles, and one profile must satisfy all selected fields. A shared adapter or format does not
make the contained benchmark families interchangeable: Harbor is a task format, while BrowserGym,
CUA-Lite and vla-eval are integration routes.

Validation is deliberately scoped. `sample-checked` records bounded real integration checks;
`adapter-tested` records adapter tests; `pending-calibration` marks outstanding real calibration.
Each product entry links its evidence and limits. None of these labels promises local installation,
every task being runnable, compatibility with every model, or full-suite statistical equivalence.
Local registrations and their calibration or method evidence remain independent of these product labels.

VLA models are evaluated **Policies**, not benchmark environments. Their concrete weights,
normalization and serving configuration belong to Policy definitions; a Method selects one policy
and freezes it for evaluation. The [compatibility matrix](guides/embodied-compatibility.md) records
the supported suite/recipe combinations, including GR00T N1.7 for LIBERO/SimplerEnv and N1.5 for
RoboCasa365. The current Agents page does not yet provide a native Policy catalog; its historical
external-entrypoint list is a different view.
