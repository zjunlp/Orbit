# Benchmark catalog

What Orbit can run today, by [integration category](integration-categories.md) and tier (design §9.14). **Runnable** counts tasks Orbit can run under their own
conditions (`orbit bench coverage`); **calibrated** means `orbit bench calibrate` (or the equivalent manual checks
before it existed) passed for real on this machine. Neither means scores were compared with official results.

| Benchmark (hub) | Category | Tier | Methods | Runnable | Calibrated | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| BFCL multi-turn (direct upstream) | C3 tool workflow · local-state | L2 | oracle, empty | 799/800; one held-out-tool reference inconsistency | Four categories × oracle/empty × two seeds; offline rescore | [BFCL sample](tasks/20261105-sample-bfcl-multiturn.md) |
| Embodied First Exam — 35 suites | C2 workspace · embodied-program / embodied-live | L0 Harbor | oracle, empty, CLI Agents | 1,938 / 2,260 (`allowlistNetwork=public`, `hostNamespaces=allow`) | MetaWorld+ (2 tasks × empty/oracle × 2 seeds); Claude Code ran one task | [P3](tasks/20261104-p3-browsergym-efe.md), [P6](tasks/20261104-p6-mainline.md), [P6.5](tasks/20261104-p65-integration.md) |
| Terminal-Bench Science / TB 4.0 | C2 workspace · terminal | L0 Harbor | oracle, empty, CLI Agents | 70/70, 56/66 | oracle/empty samples | [harbor modes](tasks/20261010-harbor-verifier-modes.md) |
| vla-eval LIBERO (libero_spatial) | C6 embodied policy · sim, step | L1 manifest and L2 adapter | empty, external | 10 tasks × 50 initial states (one per trial) | manifest: 1 task × 3 seeds = 3 different initial states, valid 0 (empty), rescore equal | [P4](tasks/20261104-p4-policy.md), [P6.5](tasks/20261104-p65-integration.md) |
| BrowserGym / MiniWoB++ | C5 GUI · browser | L2 | external, empty, CLI Agents (`gui`) | 125 / 125 | empty 125/125; Claude Code 5 sampled tasks (development) | [P3](tasks/20261104-p3-browsergym-efe.md), [P6 bridge](tasks/20261104-p6-cli-agent-bridge.md) |
| CUA-Lite (MiniWoB, WebVoyager, Online-Mind2Web) | C5 GUI · browser (+ live, judge) | L2 | external, empty, CLI Agents on MiniWoB | MiniWoB subset; Web suites need assets | MiniWoB; Web model calibration pending | [P5 GUI hubs](tasks/20261104-p5a-gui-hub-adapters.md), [P6](tasks/20261104-p6-mainline.md) |
| Cua Bench (basic desktop) | C5 GUI · desktop | L2 | external, empty, oracle | basic tasks | 5 empty/oracle pairs | [P5 GUI hubs](tasks/20261104-p5a-gui-hub-adapters.md) |
| MobileWorld | C5 GUI · mobile | L2 | external, empty | original catalog | not run (needs KVM calibration) | [P5 GUI hubs](tasks/20261104-p5a-gui-hub-adapters.md) |
| OSWorld-V2 | C5 GUI · desktop | L2 | external, empty | original catalog | not run (needs KVM calibration) | [P5 GUI hubs](tasks/20261104-p5a-gui-hub-adapters.md) |
| ASI-Bench seed31415 | C2 workspace | built-in | codex, claude-code, oracle | all | runner compatibility checks | [ASI](tasks/20261009-asi-runner-timeouts.md) |
| LongDS-Bench | C2 workspace · research-report | L2 | codex, claude-code (native runner) | lite list | a complete native Codex task | [R3](tasks/20260930-r3-bench.md) |
| ResearchClawBench, PostTrainBench | C2 workspace · research-report / ml-experiment | L2 | CLI Agents | all | adapter tests | [adapters](tasks/20261003-bench-adapter-protocol.md) |

Not runnable yet in EFE: BEHAVIOR-1K, iSpatialGym, ManiGuard and RoboWits need licensed datasets mounted from the host;
Embodied Olympics – Match uses `cap_drop` on `main`. Tasks restricted by `gpu_types` run here only with
`-c gpuTypes=any` (a recorded deviation; this machine has RTX 3090s).

Not covered yet: C1 fixed input (QA, one-shot code generation), C4 simulated-user sessions
(τ²-bench), C7 games; in C6 only LIBERO.
