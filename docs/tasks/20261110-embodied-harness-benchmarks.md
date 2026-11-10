# Embodied harness benchmarks
branch: feat/embodied-harness-benchmarks · status: completed · updated: 2026-11-10

## Goal
Integrate RLE-Bench, EmbodiedCLBench and EmbodiedLab as coding/interactive Agent benchmarks,
using existing Orbit run, service, authentication and independent verification paths.
Validate native controls and real CLI agents; keep experiment results outside the source checkout.

## Changes
- RLE-Bench: reuse native Harbor tasks and graders, retaining resource budgets and distinguishing submission failure from scorer failure. Keep incompatible runtime conditions and a native grader-isolation gap explicitly unsupported.
- EmbodiedCLBench: retain native action tools, sequence boundaries and trajectory grading.
- EmbodiedLab: separate the public robot API from private experiment evidence and native grading; drain active calls before sealing evidence, reject fatal RTX startup diagnostics, honor resolved Agent CPU/RAM resources, and require explicit bounded registration for shortened budgets.
- Publish explicit support limits and six-dimensional discovery metadata for each family.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Full repository verification | 8b741f9 | passed | Format, lint, types, boundaries, 835 tests and both builds; 26 opt-in tests not run. |
| EmbodiedCLBench native controls | working tree | passed | Basic and complete ICL reference/empty controls; independent native replay and cleanup. |
| RLE-Bench native controls | 59b4a32 | passed | Complete native empty/reference task; original reference regression floor, independent grading, saved-output empty rescore and cleanup. |
| EmbodiedLab native runtime | 59b4a32 | failed | Official image builds passed; real startup reported fatal RTX renderer errors despite exit zero. Cleanup completed; driver checks were preserved. |
| EmbodiedLab real Agent | working tree | not_run | Deferred after the runtime incompatibility; requires a compatible GPU environment. |
| EmbodiedLab false readiness regression | working tree | passed | Reject native RTX fatal diagnostics even after application-ready markers; actual Worker retest remains deferred. |
| EmbodiedCLBench real Agent | working tree | passed | Native visual tools, complete ICL context, independent grading, saved-evidence rescore and cleanup. |
| RLE-Bench real Agent | 8b741f9 | failed | Provider quota interrupted the CLI after successful tool execution and submission creation; no automatic model restart. |
| RLE-Bench partial submission verification | 8b741f9 | passed | Saved artifacts received a valid independent native score; solve failure and evaluation validity remained separate, with cleanup confirmed. |
| EmbodiedLab HTTP transport | working tree | passed | Real container, original SDK, explicit fake Worker; does not validate physics or Agent performance. |
| EmbodiedLab registry/instance dependencies | working tree | passed | Native registry loads all experiments; sampled deterministic instances derive and materialize in the real CPU image. Physics not run. |

## Next / open issues
RLE-Bench still needs an uninterrupted Agent run for full-budget model comparisons. EmbodiedLab
real experiments remain deferred until a compatible GPU environment is available; no physics
or model performance is inferred from transport tests. Native full-suite numerical equivalence
remains unverified; unsupported task/mode boundaries are documented in each adapter.
