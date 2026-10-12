# Bench adapter protocol and ResearchClawBench
branch: feat/bench-adapter-protocol · base `52b4e98` · status: completed (pending real Agent run) · updated: 2026-10-03T10:00:00+08:00

## Goal

A user's Agent can integrate a new benchmark without rebuilding Orbit: every adapter, built-in or
external, is an executable speaking one JSON protocol. ResearchClawBench (RCB) is the first external
adapter. Orbit, not the adapter, turns "run the method's Agent on this instruction" into a CLI command.

## Changes

- Protocol (design §7): `<adapter> tasks|solve|verify|score`, JSON request on stdin, JSON reply on
  stdout, cwd = benchmark path, minimal env (daemon secrets not passed), 120 s per call.
  Contracts `AdapterRequest`, `AdapterRunSpec`, `AdapterSpecResponse`, `ScoreResult`.
- `bench/protocol.ts` (daemon side): `AdapterClient` and `toRunSpec`: Agent methods give
  `agentTask: {instruction}`, Orbit builds the command (`harness.agentCommand`, moved from bench) and
  sets auth / bundle / network; benchmark `env` on both runs, `passEnv` + priority 1 on verify; the
  adapter may not set Orbit-owned fields; the result is validated as a RunSpec.
- `bench/adapter.ts` (adapter side): handler interface and `orbit __adapter <name> <op>` entry; harbor
  and asi moved behind it unchanged in behaviour. `BenchService` knows only the protocol client.
- `Benchmark`: `adapter` = built-in name or absolute executable path; `python` / `instances` → `config`
  (old registry entries are upgraded on read). Registration checks the executable and calls `tasks`.
- Trials are advanced in the background at submit and after a daemon restart (adapter calls are
  processes; neither the API nor the daemon start waits on them). Daemon option `shim` → `self`.
- CLI `bench add --adapter <name|path> -c KEY=VALUE` (replaces `--python`, `--instances`); Web chip
  shows the adapter file name.
- `examples/bench-adapters/researchclawbench/`: `adapter.py` (stdlib), `judge.py` (original
  `score_run` in the RCB `.venv`), `rcb-solve/Dockerfile` (Ubuntu 22.04 + Python 3.10 for the RCB venvs).
- Docs: design §3/§7, guide `bench-adapter.md` (rewritten for the protocol), README (en/zh), skill
  section on writing adapters, status.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | working tree on `52b4e98` | passed | 86 orbit tests + 3 skipped (opt-in Docker e2e), web 6, boundaries ok, build ok |
| New tests | same | passed | protocol client (ops, exit / bad JSON / timeout, no daemon secrets), `toRunSpec` rules, external adapter through the daemon (registration refused on failure, oracle 7/7, empty 0), asi via `orbit __adapter` |
| Built bundle runs `__adapter` | same | passed | `node dist/cli.mjs __adapter harbor tasks` |
| RCB `tasks` on the real checkout | same | passed | 40/40 supported; nothing written into the checkout |
| RCB empty, real Docker (separate daemon, `ORBIT_HOME=/tmp/...`, port 7718) | same | passed | Astronomy_000, Math_000: image build, `/task` mounts, collect, verify process, valid 0 "no report"; oracle refused with reason |
| RCB container environment | same | passed | host uid; `data/` read-only; `/task` writable; `.venv-rcb-base` (numpy 1.26.4) and `.venv-rcb-ml` (torch 2.5.1+cu121) import in the container |
| Real Agent (codex / claude-code) on RCB | — | not_run | Requires configured test credentials |
| Multi-node | — | not_run | bench runs stay on the submitting node; protocol changes nothing there |

## Next / open issues

- Real Agent run on 1–2 RCB tasks after `orbit auth add`; compare with existing leaderboard scores.
- Agent-side secrets for tools (e.g. a search API key used by RCB skills) have no per-method channel yet:
  benchmark `passEnv` reaches only the verifier.
- Judge aggregation is the mean of `attempts`; "best three of four" style aggregation is not offered.
- First image build needs access to `ubuntu:22.04`; configure Docker/BuildKit network access if needed.
- RCB `evaluation/config.py` creates `workspaces-*` / `records` dirs in the checkout on import if missing.
