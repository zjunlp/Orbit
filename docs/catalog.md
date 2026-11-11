# Supported benchmark catalog

The Web **Benchmarks** library lists the benchmark families Orbit has adapters for, even when
the current machine has no registrations or evaluation history. A family appears once; its
integration routes, suites, recipes and validation limits appear in the details. Local registrations
remain a separate view, and execution history belongs in Evaluations and Runs.

The authoritative product data is [bench/benchmarks/](../packages/orbit/src/bench/benchmarks/),
with the shared response shape in [contracts/bench.ts](../packages/orbit/src/contracts/bench.ts).
This document links the supported routes and explains how to read the catalog. [Six dimensions](design.md#917-benchmark-六维分类-v12026-11-09)
· [Catalog contract and behavior](design.md#918-已适配-benchmark-产品目录2026-11-09)

The public classification has **six independent dimensions**, each with controlled values;
these are not six mutually exclusive benchmark categories. The Web shows a card for each dimension.

| Dimension | Fields and value counts | Example values |
| --- | --- | --- |
| Domain | `domains` (12) | Software engineering, natural science, robotics, games |
| Task type | `taskTypes` (14) | Answering, implementation, repair, manipulation |
| Evaluation target | `targets` (14) | Reasoning, planning, tool use, control |
| Interface & modality | `modalities` (5), `interfaces` (6) | Image / text input; terminal / GUI / physical-control actions |
| Environment & interaction | `platforms` (6), `world` (2), `feedback` (3), `participants` (4) | Browser / simulation; controlled / live; step / realtime; teammate / opponent |
| Scoring | `scoringEvidence` (4), `scoringMethods` (5) | Artifact / final-state evidence; execution tests / model judges |

The full vocabulary and matching rules live in [design §9.17](design.md#917-benchmark-六维分类-v12026-11-09).
A task or profile can have multiple values. Counts are discovery metadata, not evidence of calibration
or model capability; product families, local registrations and evaluated tasks remain separate counts.

| Area | Benchmark families | Setup and scope |
| --- | --- | --- |
| Code generation and terminal work | HumanEval; Terminal-Bench 4.0; FrontierSWE v2 | [HumanEval adapter](../examples/bench-adapters/humaneval/) · [Harbor support](tasks/20261010-harbor-verifier-modes.md) |
| Research and model development | ASI-Bench; LongDS-Bench; ResearchClawBench; PostTrainBench; Terminal-Bench Science; WANDR | [ASI conditions](tasks/20261009-asi-runner-timeouts.md) · [LongDS adapter](../examples/bench-adapters/longds/) · [ResearchClawBench adapter](../examples/bench-adapters/researchclawbench/) · [Adapter protocol](tasks/20261003-bench-adapter-protocol.md) |
| Tools, user interaction and games | BFCL; τ²-bench; TextArena; AutomationBench | [BFCL](tasks/20261105-sample-bfcl-multiturn.md) · [τ²-bench](tasks/20261105-sample-tau2.md) · [Game integration](tasks/20261105-samples-c1-c7.md) |
| Browser, desktop and mobile tasks | MiniWoB++; WebVoyager; Online-Mind2Web; Cua Bench; MobileWorld; OSWorld-V2 | [GUI guide](guides/gui-bench-web.md) · [CUA-Lite](../examples/bench-adapters/cua-lite/) · [Cua Bench](../examples/bench-adapters/cua-bench/) · [MobileWorld](../examples/bench-adapters/mobileworld/) · [OSWorld-V2](../examples/bench-adapters/osworld-v2/) |
| Visual reasoning | Chartography | [Native no-tools adapter](../examples/bench-adapters/chartography/) · released data calibration pending |
| Embodied coding-agent tasks | Embodied First Exam; RLE-Bench; EmbodiedCLBench; EmbodiedLab | [Harness adapters](tasks/20261110-embodied-harness-benchmarks.md) · [EFE integration](tasks/20261104-p3-browsergym-efe.md) · [Execution boundaries](design.md#94-被评测对象agent-与-policy) |
| Native embodied policies | [Families and task coverage](guides/embodied-compatibility.md#benchmark-接入范围) | [Quickstart](guides/embodied-quickstart.md) · [Verified policies](guides/embodied-compatibility.md#真实模型实测) · [Onboarding](guides/embodied-onboarding.md) |

The area column is a reading aid. The six-dimensional filters use the source catalog's explicit
profiles, and one profile must satisfy all selected fields. A shared adapter or format does not
make the contained benchmark families interchangeable: Harbor is a task format, while BrowserGym,
CUA-Lite and vla-eval are integration routes.

Each product entry carries a short validation note: which calibration or checks were run, on what
scope, with a link to the evidence. It records facts, not grades (design §9.10). It does not promise
local installation, every task being runnable, compatibility with every model, or results equal to
the official runner. Local registrations keep their own calibration and Agent/Policy evidence.

VLA models are evaluated **Policies**, not benchmark environments. Their concrete weights,
normalization and serving configuration belong to Policy definitions; an evaluation configuration selects one policy
and freezes it for evaluation. The [compatibility matrix](guides/embodied-compatibility.md) records
the supported suite/recipe combinations, including GR00T N1.7 for LIBERO/SimplerEnv and N1.5 for
RoboCasa365. The current Agents page does not yet provide a native Policy catalog; its historical
external-entrypoint list is a different view.

Each benchmark is described by three things only: its six-dimensional classification, how Orbit
integrates it (`harbor`, `manifest`, `sdk` or `native`, plus the concrete adapter), and its calibration
record. Older records may mention the retired C1–C7 categories; they are compatibility fields only.

[New native integrations](tasks/20261110-benchmark-gaps.md) · [Original-suite availability and protocol gaps](guides/benchmark-availability.md)
