# Per-task bench resources and measured run usage
branch: refactor/ts-rewrite · base `f467d1e` · status: completed · updated: 2026-10-03T16:30:00+08:00

## Goal

Tasks of one benchmark need very different resources (some train on a GPU, most do not). Give each
task its solve resources from a reviewed file instead of one size or per-run Agent guesses (as DSec
and Kubernetes do: hardware needs declared, sizes in a few classes), measure what runs actually use,
and suggest corrections from those measurements (Autopilot-style peak + margin) without applying
them. Out-of-memory solves must not count as the method's zeros. Teach Agents all of this in a
separate `orbit-bench` skill.

## Changes

- `Run.usage` (`runs/usage.ts`): sampled every 5 s; docker runs from the container cgroup v2
  (`memory.peak`, `cpu.stat`, `memory.events`), process runs from the process group's `/proc` RSS /
  CPU time plus labelled child containers; GPU memory from `nvidia-smi` compute apps matched by host
  pid. Saved while running (no change events), final sample before the terminal state, a `usage`
  event; continued after a daemon restart without double-counting OOM kills; mirrored for remote
  runs. Runs too short to be seen get no usage. `oomKilled` only when the container was OOM-killed
  and exited non-zero.
- Bench: `classify` makes an OOM-killed solve (or verify) invalid with the limit and peak in the
  issue; memory kills in a surviving solve are noted.
- Resources file (`contracts.BenchResources`, `bench/resources.ts`): `bench add --resources`,
  validated at registration and submit (unknown fields and task ids are errors); task > default >
  adapter, `--timeout` wins; resolved values stored on `BenchJob.resources`; solve runs only.
- `orbit bench usage <job>... [--suggest]` / `GET /bench/usage`: per-task peaks of Agent-method solve
  runs vs request, suggestions (memory/GPU memory peak × 1.2 to a step, raise after OOM, lower only
  from ≥ 2 runs with half to spare; CPU step; timeout × 1.5 to the hour; never GPU count), printed only.
- CLI `show` usage line; Web run Overview "Measured", bench table resources file, task resources on
  hover in the matrix.
- Skill `plugin/skills/orbit-bench` (study the benchmark, adapter, resources file, validation,
  revising from usage); the main `orbit` skill points to it and mentions measured usage.
- Docs: design §4/§7, adapter guide §4, README (en/zh), plugin README, RCB example README, status.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | working tree on `f467d1e` | passed | orbit 93 + 3 skipped (opt-in Docker e2e), web 6, boundaries, build |
| New unit tests | same | passed | cgroup / proc / nvidia-smi parsing, meter peaks, CPU rate, OOM not double-counted after restart; resources validation, merge, override, suggestions; OOM classification |
| Daemon test | same | passed | bad resources file refused at registration; overrides reach the solve run only; process-run usage recorded; oracle runs left out of `bench usage` |
| Real Docker: OOM | same | passed | 1 GB limit, growing allocation → `failed (out of memory (limit 1 GB))`, usage OUT OF MEMORY |
| Real Docker: child killed, run survives | same | passed | `succeeded`, usage "1 killed for memory" |
| Real Docker + GPU | same | passed | 2 GB CUDA tensor + 2 GB RAM: usage RAM 2.242 GB (docker stats 2.24 GiB), GPU 2.289 GB, CPU peak 1.08 of 2 |
| Process run with child container | same | passed | 300 MB host process + 700 MB child container → peak 0.807 GB |
| Daemon restart mid-run | same | passed | sampling continued, usage recorded at the end |
| Agent-method `bench usage` on real runs | — | not_run | Requires configured test credentials |

## Follow-up: in-run Agent sessions

- `RunSessions { submitter, submitterError, agent }` from `GET runs/:id/session`; `agent` is the newest
  transcript in the run's Agent home (`orbit/agent/codex/sessions`, `orbit/agent/claude/projects`,
  Claude subagents skipped); remote runs have none on the primary.
- Web Session tab: both → two panes (submitter left, in-run Agent right); one → that one full width.

| Check | Result | Notes |
| --- | --- | --- |
| `pnpm verify` | passed | + test for finding Codex / Claude transcripts in a run's Agent home |
| Real auth-test run | passed | container Codex session parsed: 6 messages ending `ORBIT_AUTH_OK` |
| Browser (headless Chromium, test daemon) | passed | both → 2 panes; agent only → full; submitter only → full with "Where this run was submitted"; linked but missing submitter + agent → agent |

## Next / open issues

- Requests and limits are the same value (no oversubscription); Agent solves are mostly idle.
  Separate request / limit if GPU or memory becomes the bottleneck.
- `gpuMemGB` filters by a GPU's total memory; leases are whole GPUs.
- A task needing more GPUs than any node has stays queued with the reason (no early refusal).
