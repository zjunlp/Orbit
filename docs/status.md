# Orbit status

Updated 2026-11-12. Architecture: [design](design.md). Docs map: [docs/README](README.md). Task records: [index](tasks/README.md).

**Stage.** R0–R2 validated on this machine. R3 benchmarks run: LongDS with one complete native Codex task, Harbor with oracle/empty samples. R4 (multi-node) only as two daemons on one machine. No release blockers.

## Available

- **Package and plugins.** npm [`@zjunlp/orbit`](https://www.npmjs.com/package/@zjunlp/orbit) ships Web, skills and licenses; one-command plugins for Claude Code, Codex, dsh and pi ([plugin guide](../plugin/README.md), [releasing](guides/releasing.md)).
- **Daemon and CLI.** Auto-started local daemon (127.0.0.1, token/cookie, single writer per home); `orbit run / sweep / ps / show / logs / wait / cancel / note / resources / doctor / web / auth / notify / bench / node / data`; `pnpm verify` gates changes.
- **Resources.** Leases with queue reasons; outside use respected (busy GPUs, CPU, `MemAvailable`); `orbit reconcile` every 10 min; at most `ORBIT_MAX_STARTING` (4) starts and none under 5 GB free disk; GPU holders and device leases in CLI/Web; KVM/DRI/TUN/adb/serial probes.
- **Execution.** Docker with code snapshot, CDI GPU mapping checked against the lease, execution-only timeouts, durable ending phases, evidence collected before cleanup; opt-in failure [checkpoints](guides/checkpoints.md) and `orbit resume`; `--check` / `--smoke` preflight; separate data directory and logical folders.
- **Trajectories.** ATIF v1.5–v1.8 contract and pure Codex / Claude Code converters; tool pairing, usage, compaction, Claude subagents and media extraction. Run storage/API/CLI integration remains T2.
- **Agents.** Registry of 12 Agents plus user definitions (`orbit agent …`), installed inside the run when needed. Real runs: codex, claude-code, dsh; the other nine are unverified. Auth profiles per Agent; notifications (Feishu, DingTalk, WeCom, Slack, webhook; Feishu app bot).
- **Bench core.** Solve + independent verify per trial; valid-only means with task-clustered CI and paired Δ; benchmark's official aggregation shown alongside; closed failure kinds; immutable report revisions; `rescore`, `consolidate`, `usage`, `calibrate`, `coverage`.
- **Integration.** One adapter protocol behind four integration methods: `harbor`, `manifest`, `sdk`, `native` (design §9.14). Harbor covers compose services, hooks, per-role GPUs and verifier GPU models; TB-Science 70/70 and TB 4.0 56/66 supported.
- **Describing benchmarks.** Six-dimensional taxonomy, integration method, calibration record (design §9.10). Product library of 39 families ([catalog](catalog.md), [availability](guides/benchmark-availability.md)).
- **Calibrated samples.** Bounded empty/oracle or scripted calibration for HumanEval, EFE MetaWorld+, BFCL, τ²-bench, MiniWoB, LIBERO, TextArena, Cua Bench basic desktop, CUA-Lite MiniWoB; BFCL also has a real CLI Agent check.
- **GUI.** Private signed GUI service (`orbit-computer` CLI/MCP); Claude Code and Codex verified on sampled MiniWoB/BrowserGym tasks; MCP servers wired into Claude/Codex homes ([GUI guide](guides/gui-bench-web.md)).
- **Embodied.** Native policy evaluation with semantic bindings, frozen samples, CPU evidence verification and rescore; shared model services in batches ([quickstart](guides/embodied-quickstart.md), [compatibility](guides/embodied-compatibility.md)). Harness benchmarks RLE-Bench, EmbodiedCLBench, EmbodiedLab T0 via Agent adapters.
- **Web.** Overview · Benchmarks · Agents · Configurations · Evaluations · Runs · Resources; trial page built from evidence shapes (conversation, GUI steps, embodied timeline, test report, rubric, grouped evidence files); evaluation configurations grouped by content revision.
- **Multi-node.** Workers join by token; placement, hashed code bundles, named datasets, mirrored logs and artifacts ([guide](guides/multi-node.md)).

## Main gaps

- **Validation.** Only calibration (pipeline connected) is required now. No benchmark has been compared with its official runner; full-suite statistical equivalence is unverified.
- **Not run for real.** MobileWorld / OSWorld-V2 KVM calibration; EFE GPU tasks; EmbodiedLab experiments (RTX startup); WebVoyager and Web judge calibration; R4 on two machines; LongDS Claude continuation.
- **Missing.** Environment pools and `slots`; trajectory importers beyond EFE, RoboTwin and LIBERO; licensed-data volumes (BEHAVIOR, ManiGuard); allowlist networks, multi-step Harbor tasks, Harbor MCP tool sets; MCP server; native Policy view in Agents; bundle cache eviction.
- **Known issues.** Docker [`userns-remap`](guides/docker-userns-remap.md) breaks Run output writes and is not detected; daemons of different users on one machine can lease the same free GPU.

## Next

1. Web: Catalog filter memoization, abort stale `useAsync` requests, virtualize long conversations.
2. EFE GPU tasks, licensed-data volumes, KVM calibration of MobileWorld / OSWorld-V2.
3. Real Agent bench jobs (RCB first); R4 on two machines; later, official-runner comparison for a few classic benchmarks.
4. Evolution line: T1 trajectory contract/converters implemented; next T2 Run storage/API/CLI, then token accounting, export, fork and the gate ([plan](evolution-plan.md)).
