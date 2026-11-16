# Evidence-backed benchmark taxonomy
branch: fix/benchmark-taxonomy-evidence · status: completed · updated: 2026-11-16

## Goal

Make the six-dimensional product catalog describe the benchmarks and protocol variants Orbit actually
integrates, with enough evidence to distinguish missing annotations from missing coverage.

## Changes

- Audit family tags against adapter observations, allowed actions, task scopes and native scoring.
  Preserve unknown fields instead of inferring capabilities from names, screenshots or task length.
- Add the previously omitted BiGym 2.0, CLIPort and LIBERO-Mem product entries and exact native profile
  links. Their adapters already exist; retain the limits in their original validation records.
- Keep input layouts and distinct evaluation tracks in separate taxonomy groups. Classification does
  not alter execution, local registrations, frozen evaluation evidence or calibration claims.

The audit covers all 46 entries and produces 79 profiles. Six families still have no verified domain
mapping and sixteen have no verified evaluation target. Unknown metadata is not zero capability.
In particular, model training tasks do not establish that the evaluated Agent learns/adapts, and
fixed oracle tool replay does not establish a supported interactive Agent route.

| Correction | Evidence and limit |
| --- | --- |
| ASI mathematics and robotics | [Original task metadata](https://github.com/apexin-ai/ASI-Bench/tree/54397d39202cb6b3d43b2b8621afdc95b0b9eb5b/tasks); other computer-science/engineering subjects and mixed task types remain unspecified |
| FrontierSWE subject/task pairs | [Pinned original instructions](https://github.com/Proximal-Labs/frontier-swe-v2/tree/da83f84f8fbcec3cbf0f2b17c98ebc811355c2df/tasks); four inspected tasks get separate profiles, remainder stays unknown |
| TB-Science mathematics, healthcare and robotics | [Pinned original instructions](https://github.com/harbor-framework/terminal-bench-science/tree/0efab0e6d7c6af5886e838990352ab85484cc234/tasks); Lean proof, ankle MRI and TAMP skill planning are separate profiles |
| LongDS memory and research domains | [Original stateful analysis design](https://github.com/zjunlp/DataMind/tree/main/longds); only unambiguous business/geoscience subjects get domains |
| ResearchClawBench mathematics/ML | [Original research domains](https://github.com/InternScience/ResearchClawBench#-scientific-domains); writing analysis code does not make every task software engineering |
| AutomationBench finance and scoring | [Public suites](../../examples/bench-adapters/automationbench/adapter.py), [final-world assertions](../../examples/bench-adapters/automationbench/runtime.py); retained trajectories are not themselves success evidence |
| Native observation variants | [RoboMimic](../../examples/sdk/orbit_embodied/robomimic.py), [native setup](../../examples/bench-adapters/embodied/README.md); low-dimensional inputs, RGB-only recipes and target coordinates stay separate |
| VLA-Arena targets | [Pinned suite purposes](https://github.com/PKU-Alignment/VLA-Arena/tree/babe582ebffc82b979b77964a7e56417d02f63a4#task-suites-overview), [implemented suites/probes](../../examples/bench-adapters/embodied/benchmarks/vla-arena/README.md); safety, robustness, generalization and planning remain distinct profiles |
| VLABench generalization | [Fixed tracks and open cross-task scope](../../examples/bench-adapters/embodied/benchmarks/vlabench/README.md); open training/evaluation splits do not automatically establish held-out generalization |

Key evidence for the restored entries:

| Family | Classification evidence | Validation scope |
| --- | --- | --- |
| BiGym 2.0 | [Native learned-policy protocol](../../examples/bench-adapters/embodied/benchmarks/bigym2/README.md); [observation/action profile](../../examples/sdk/orbit_embodied/bigym2.py) | [Native reset and fixed-action checks](20261112-bigym2.md); trained-policy and full-suite checks remain open |
| CLIPort | [Language test and seen/unseen variants](../../examples/bench-adapters/embodied/benchmarks/cliport/README.md); [RGB-D and language inputs](../../examples/sdk/orbit_embodied/cliport.py); [upstream generalization protocol](https://github.com/cliport/cliport/tree/2be5c47b5bb9bb7040ad90693288b87b1e18e7ad) | [Sampled oracle and released-policy checks](20261112-cliport.md), not the full seed catalog |
| LIBERO-Mem | [Ordered-goal adapter](../../examples/bench-adapters/embodied/benchmarks/libero-mem/README.md); [explicit memory benchmark design](https://github.com/libero-mem/libero-mem/tree/0eee0defa4024e51511b6e15a79f30e9620209de) | [All-task resets and one frozen policy sample](20261114-libero-mem.md), not full-suite model evaluation |

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Source and protocol audit | working tree | passed | Independent review of target, input and interaction claims; 46 entries and 79 profiles parse through the public contract |
| Initial verification environment | working tree | failed | System Python lacked existing embodied-test dependencies; resolved in an isolated test environment with repository-pinned websockets/msgpack packages |
| Embodied Python fixture regressions | working tree | passed | 35 tests with the declared dependencies and local socket access; synthetic environments, not native physics/model checks |
| `pnpm verify` | working tree | passed | Formatting, lint, types, boundaries, 910 core tests, 136 Web tests, 5 script tests and both builds; 28 opt-in core tests skipped |
| New Docker/GPU evaluation | working tree | not_run | Metadata-only change; existing validation records retained without upgrading their claims |

## Next / open issues

- Unverified fields and uncalibrated original suites remain explicit gaps.
