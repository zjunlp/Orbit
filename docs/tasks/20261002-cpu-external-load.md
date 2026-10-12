# CPU admission counts CPU use outside Orbit

`refactor/ts-rewrite` · base `9b256f1` · completed · 2026-10-02T17:20:00+08:00

## Goal

Processes started outside Orbit consumed CPUs, but the Resources page and scheduler counted only
Orbit leases and could admit work beyond the remaining capacity. GPUs and memory already
respected use outside Orbit; CPUs counted leases only. Acceptance: new runs wait (with a reason)
while other processes keep CPUs busy; running runs are never stopped; CLI and Web show measured use
next to leases.

## Changes

- `resources/probe.ts`: `parseProcStat` + `CpuMeter` measure CPUs in use from `/proc/stat` between
  probes (rises at once, falls with a 30 s time constant; load average until two samples exist).
  `NodeResources.cpu.busy` added to the contract.
- `resources/allocate.ts`: `cpuOutside` = busy − leases older than 60 s − noise (5% of cores, ≥ 1);
  admission needs leased + outside + request ≤ cores. Runs leased in the same pass or still starting
  count by their lease on top of the measurement (errs towards waiting). Reason e.g.
  `waiting for CPUs (36/40 free, ~44 busy outside Orbit)`.
- CLI `orbit resources` and Web Resources (stat card + thin "in use" bar, worker table) show in-use
  CPUs. Design §4, README (en/zh), status updated.

## Decisions

- Usage-aware admission on top of lease accounting (as HTCondor / load-aware Kubernetes plugins do),
  not usage-only scheduling: leases still reserve; measurement only covers what Orbit cannot see.
- `/proc/stat` instead of load average: load counts D-state tasks and lags about a minute.
- No preemption: use outside Orbit only delays new runs.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | 9b256f1 + this change (workspace) | passed | orbit 83 passed / 3 skipped, web 6 passed; biome, tsc, boundaries, builds |
| `test/allocate.test.ts` (3 new cases) | same | passed | external CPU queueing and reason, noise tolerance, settled vs starting leases, `/proc/stat` parsing and meter rise/fall |
| Real CPU probe | same | passed | Measured external CPU use agreed with `top` |
| Web Resources page in a browser | — | not_run | typecheck and build only |

## Next / open issues

- A run whose lease is older than 60 s but still idle (e.g. a long image pull) is assumed busy up to
  its lease, so use outside Orbit is underestimated during that time.
- Process-backend and container usage is not measured per run; only the node total is.
