# Who holds each GPU

branch: feat/gpu-processes · status: completed · updated: 2026-10-08

## Goal

A busy GPU said only "busy (external)". Show which processes hold it: user, PID, command, container
or Orbit run, memory, and how long they have been running. Unreadable fields show as unknown.

## Changes

- `resources/gpu-procs.ts` (new): compute apps from `nvidia-smi --query-compute-apps`, described from
  `/proc/<pid>/{status,stat,comm,cmdline,cgroup}`, `/proc/stat` (btime), `/etc/passwd`,
  `getconf CLK_TCK` and a cached `docker ps` (container name + `orbit.run` label). Command lines are
  reported without arguments — arguments may carry secrets.
- `contracts.GpuProcess` + `Gpu.processes` (largest first; the driver may not list processes at all).
- `resources/probe.ts`: `classifyGpus` attaches the described processes; `parseComputeApps` moved to
  `gpu-procs.ts`.
- Web GPU cards list one row per process (command, memory, user, pid · container · runtime, link to
  the run when the container is ours); CLI `orbit resources` prints a line per process.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Unit tests (parsers, describe, classify) | working tree | passed | `test/probe.test.ts`, `test/allocate.test.ts` |
| `pnpm verify` | working tree | passed | Biome, tsc, boundaries, 113 tests, build |
| Real GPU, host process | this machine | passed | `python3` holding 1 GiB → Process owner, command and start time correct, container/runId null |
| Real GPU, container process | this machine | passed | `docker run --gpus all --label orbit.run=…` → container name and runId read from the cgroup + docker |

## Next / open issues

- Not checked on a GPU whose driver hides compute processes (the fallback then shows used memory
  only, and the process list stays empty).
- Worker nodes: the process detail comes from each node's own probe, so it appears for the selected
  node on the Resources page.
