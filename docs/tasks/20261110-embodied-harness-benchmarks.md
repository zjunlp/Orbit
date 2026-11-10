# Embodied harness benchmarks
branch: feat/embodied-harness-benchmarks · status: in_progress · updated: 2026-11-10

## Goal
Integrate RLE-Bench, EmbodiedCLBench and EmbodiedLab as coding/interactive Agent benchmarks,
using existing Orbit run, service, authentication and independent verification paths.
Validate native controls and real CLI agents; keep experiment results outside the source checkout.

## Changes
- RLE-Bench: reuse native Harbor tasks and graders, retaining resource budgets and distinguishing submission failure from scorer failure. Keep incompatible runtime conditions and a native grader-isolation gap explicitly unsupported.
- EmbodiedCLBench: retain native action tools, sequence boundaries and trajectory grading.
- EmbodiedLab: separate the public robot API from private experiment evidence and native grading; drain active calls before sealing evidence and honor resolved Agent CPU/RAM resources.
- Publish explicit support limits and six-dimensional discovery metadata for each family.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Full repository verification | working tree | passed | Format, lint, types, boundaries, 835 tests and both builds; 26 opt-in tests not run. |
| EmbodiedCLBench native controls | working tree | passed | Basic and complete ICL reference/empty controls; independent native replay and cleanup. |
| RLE-Bench native controls | working tree | not_run | Native images prepared; controls running. |
| EmbodiedLab native runtime | working tree | not_run | Official runtime download in progress. |
| EmbodiedCLBench real Agent | working tree | passed | Native visual tools, complete ICL context, independent grading, saved-evidence rescore and cleanup. |
| RLE-Bench real Agent | working tree | not_run | Native task running with full budgets. |
| EmbodiedLab HTTP transport | working tree | passed | Real container, original SDK, explicit fake Worker; does not validate physics or Agent performance. |
| EmbodiedLab registry/instance dependencies | working tree | passed | Native registry loads all experiments; sampled deterministic instances derive and materialize in the real CPU image. Physics not run. |

## Next / open issues
Finish RLE-Bench native calibration and sampled Agent evaluation, check the EmbodiedLab GPU
runtime, then repeat repository verification after the final review fixes.
