# BEHAVIOR-1K and RobotAgentBench integration
branch: feat/behavior-robotagent-bench · status: blocked · updated: 2026-11-13

## Goal
Integrate both benchmarks through the current per-family catalog and existing adapter/Run contracts,
preserving original task ownership, evaluation budgets, private grading and saved evidence.

## Changes
- BEHAVIOR-1K extends native Policy execution with the original 2026 R1Pro evaluator, one native
  action per query and public ordinals 0–19 mapped to IDs 301–320. Keep all 1,016 released activities
  visible; the challenge recipe supports its 100 metadata-backed activities, with 20 instances each.
- Licensed assets use named read-only datasets and content fingerprints that exclude the key.
  Reference-only setup and the existing sample planner work without starting simulation.
- RobotAgentBench reuses the original raw-22 worker and RawRobotBridge behind public MCP tools.
  Retain all 49 groups / 1,470 configurations; 29 ordinary groups can be prepared. Dedicated owners
  and OpenEnd/discovery score profiles remain explicitly unsupported.
- Each trial copies its Runtime, preserving original aliases and native cache ownership.
  Scoring requires native termination, delayed close ACK, worker exit and original shutdown receipts.
  Finished owner results alone do not establish completion; abandoned attempts are invalid.
- Both families reuse existing Run services, resource allocation, CLI Agent launch and CPU rescore.
  No new BenchService branch, TrialMachine, Agent loop, resource ledger or Web routing.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Source/catalog review | working tree | passed | Pinned original catalogs and all 20 public-instance mappings checked; no simulator import. |
| Adapter / evidence regressions | working tree | passed | Synthetic CPU fixtures cover isolation, ordinal rejection, query watchdog, raw actions, native reports, completion and scoring. Shared Run/catalog contracts pass. |
| Original raw bridge in an Orbit container | working tree | passed | 19 upstream CPU fixture tests; no model, GPU or native physics. |
| Original owner receipts and signed evidence | working tree | passed | CPU integration rejects missing ACK, wrong task, abandonment, incomplete execution and altered files; synthetic fixtures only. |
| Agent image / MCP in an Orbit container | working tree | passed | Final image has Node 24 / Python 3.11 / MCP 1.26; real stdio/HTTP transport preserves original text/images, rejection and one-send actions. Synthetic worker only. |
| Repository verification | working tree | passed | pnpm verify: format, lint, types, boundaries, tests and build. |
| Native physics / model calibration | working tree | not_run | Requires compatible Isaac Sim 5.1 RTX runtime and prepared native images / saved RobotAgentBench Runtime. |

## Next / open issues
Finish native environment preparation and calibrate original reset, control, stopping and cleanup
before treating either route as a validated native benchmark. Resource estimates remain provisional.
No full-suite statistical equivalence is claimed.
