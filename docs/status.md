# Orbit status

- **Updated at:** 2026-10-12
- **Basis:** Bench task append, consolidation and Harbor compatibility; repository records contain reusable technical content only.
- **Stage:** R0–R2 validated here; R3 bench smoke-tested with oracle/empty only; R4 only as two daemons on one machine.
- **Blockers:** none for implementation; first npm publication deferred by the user (publisher authentication still needed).

## Available

- npm tarball with Web and shared skills; one-command native plugins for Claude Code, Codex, dsh and pi. Isolated real installs and skill loading verified. [Plugin guide](../plugin/README.md) · [Release guide](guides/releasing.md).
- `pnpm verify` (Biome, tsc, boundaries, vitest, builds). Auto-started local daemon (127.0.0.1, token/cookie, sqlite); `orbit run / sweep / ps / show / logs / wait [-g] / cancel / note / resources / doctor / web / auth / notify / bench / node / data`.
- Resource leases with a queue (with reasons); use outside Orbit is respected (busy GPUs, measured CPU use, `MemAvailable`). Docker executor: code snapshot, CDI GPU mapping checked against the lease,
  execution-only timeouts; logs, metrics and outputs collected before cleanup. Process backend for native runners, with a labelling, GPU-limiting docker shim.
- Session linking; Web UI: runs, run detail, trial page, compare, resources, settings, bench; typed-confirmation deletion.
- Who holds each GPU (user, command, PID, container/Run, memory, runtime; else unknown) in Web and CLI.
- Pre-flight `orbit run|sweep --check` (data, output disk, image, placement); `--smoke '<cmd>'` gates submission.
- Data directory apart from `~/.orbit` (`orbit config data`, `ORBIT_DATA`), doctor disk warnings; logical folders (`--folder`, `mv`, `folders`, `export`).
- Auth profiles for Codex and Claude Code; notifications (Feishu, DingTalk, WeCom, Slack, webhook; `feishu-app` bot: `orbit feishu init` QR setup, pairing, read-only `/gpu` `/runs` `/show`, curve cards).
- Bench: solve + verify run per trial, valid-only means (OOM solves invalid); one JSON adapter protocol
  for built-ins and external executables (e.g. ResearchClawBench); per-task resources file; `bench usage`
  suggestions; `bench consolidate` previews/merges retries and appends new tasks with validity retained; `orbit-bench` skill; `bench rescore` re-verifies from saved solve outputs (history kept). Measured peak memory / CPU / GPU memory on every run. Adapter-declared
  metrics (`score` built in): per-task then over-task means, task-clustered 95% CI, paired Δ in compare. ASI checks known runner incompatibilities before Agent launch, propagates failures, and shows latest attempt status separately from score validity.
- Harbor format: separate/shared verifiers, compose services, collect hooks, Harbor's network/image rules; TB-Science 70/70 and TB 4.0 56/66 supported (oracle/empty checked on samples incl. all 5 compose tasks); jobs record the benchmark commit.
- Multi-node: workers join by token; placement across nodes, code bundles by hash, named datasets, mirrored logs/metrics, proxied artifacts. Guide: [guides/multi-node.md](guides/multi-node.md).

## Main gaps

- ASI / TB-Science scores not yet compared with official Harbor runs (only oracle-level); codex lacks Harbor's `unified_exec`; no GPU-type placement, allowlist networks, multi-step tasks or MCP servers for Harbor tasks. R4 not run on two real machines; no bundle cache eviction.
- Per-user daemons on one machine (busy 7717 → free port) can lease the same free GPU at once; fix when needed with a shared per-GPU lock.
- Bench metrics: tests and fake adapters only; group notifications may fire between solve and verify. Untried: some auth kinds, real IM webhooks (the Feishu app was checked on a phone). No MCP server or dsh/pi session capture/in-container harnesses; no overcommit.

## Next priorities
1. Real Agent bench jobs (RCB first), Web `/bench`, R4 on two machines.
2. Paired Agent runs Orbit vs `harbor run` on sampled TB-Science tasks; LLM-judge / pairwise scoring for non-Harbor benchmarks.

## Records

[design.md](design.md) · [R0](tasks/20260929-ts-rewrite-r0.md) · [R1](tasks/20260930-r1-research-loop.md) · [R2](tasks/20260930-r2-auth-notify.md) · [R3](tasks/20260930-r3-bench.md) · [R4](tasks/20260930-r4-multinode.md) · [review](tasks/20261001-code-review.md) · [cpu](tasks/20261002-cpu-external-load.md) ·
[adapters](tasks/20261003-bench-adapter-protocol.md) · [resources](tasks/20261003-bench-resources-usage.md) · [validity](tasks/20261004-bench-validity-checks.md) · [web](tasks/20261004-web-jobs-trials-delete.md) · [metrics](tasks/20261005-bench-metrics.md) · [folders](tasks/20261005-data-dir-folders.md) · [gpu-procs](tasks/20261006-gpu-processes.md) · [preflight](tasks/20261008-preflight-smoke.md) · [rescore](tasks/20261008-bench-rescore.md) · [feishu-app](tasks/20261008-feishu-app.md) · [feishu-init](tasks/20261008-feishu-init.md) · [npm](tasks/20261008-npm-plugin-install.md) · [plugins](tasks/20261008-agent-plugins.md) · [ASI compatibility](tasks/20261009-asi-runner-timeouts.md) · [timeouts](tasks/20261009-bench-timeout-classification.md) · [harbor modes](tasks/20261010-harbor-verifier-modes.md) · [sidecars](tasks/20261010-harbor-sidecars.md) · [harness parity](tasks/20261010-harness-parity.md) · [shared verifier](tasks/20261010-harbor-shared-verifier.md) · [collect hooks](tasks/20261010-harbor-collect-hooks.md)
