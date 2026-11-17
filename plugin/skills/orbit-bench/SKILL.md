---
name: orbit-bench
description: Integrate a benchmark into Orbit and size its tasks — write an adapter executable for a benchmark Orbit does not know (any format, no Orbit rebuild), write or update its resources.json (GPU / memory / CPU / timeout per task), and validate it. Use when asked to make a benchmark runnable with `orbit bench`, to decide per-task resources, or to act on `orbit bench usage`.
---

# Orbit bench: adapters and task resources

Orbit runs every benchmark trial as a **solve** run (the method's Agent works on the task) and a
separate **verify** run (the benchmark's grader), and averages only scores it can trust. A
benchmark is connected through an **adapter**: a small executable that describes those two runs and
reads the score. Orbit is not modified or rebuilt. Read the
[adapter guide](https://github.com/zjunlp/Orbit/blob/main/docs/guides/bench-adapter.md);
[ResearchClawBench](https://github.com/zjunlp/Orbit/tree/main/examples/bench-adapters/researchclawbench)
is a complete example. In a checkout these are `docs/guides/bench-adapter.md` and
`examples/bench-adapters/researchclawbench/`.

Use `orbit` when it is on PATH. Otherwise replace `orbit` in the commands below with
`npx -y @zjunlp/orbit` (requires Node.js 24.18+ in the 24.x line); no source checkout is needed
to use the CLI. Run `doctor` before the first benchmark job.

For an already supported benchmark, start with `orbit bench resources <family>` and
`orbit bench prepare <family>`. This downloads official resources, reuses local paths with
`--reuse RESOURCE=PATH`, and lists authorization or native environment prerequisites.
Follow `orbit logs <run> -f`, then check `orbit bench preparation <run>` for registration
and next steps. Preparation is distinct from calibration. The installed package carries
these adapters and helpers; see the [resource guide](https://github.com/zjunlp/Orbit/blob/main/docs/guides/benchmark-resources.md).

## 1. Study the benchmark first

Before writing anything, find out from the benchmark's own code and docs (and write it down for the
user in a few lines):

- Where the task list comes from, and which tasks cannot run (say why; never drop them silently).
- What the Agent receives (instruction text, files, working directory) and what it must produce.
- How the original grader runs: command, environment (Python, packages), inputs, where it writes the
  score, its scale, and its failure modes (missing output, API errors, internal errors).
- Whether a reference solution exists (`oracle`), and what an empty submission should score.
- Secrets the grader needs (API keys): they are passed by name with `--pass-env`, never stored.

Reuse the original code for instructions and grading instead of re-implementing it: scores must stay
comparable with results produced by the benchmark's own tools.

## 2. Write the adapter

Any language; usually one Python file with the standard library only. Orbit runs
`<adapter> tasks|solve|verify|score` in the benchmark directory, one JSON request on stdin, one JSON
reply on stdout; on error write stderr and exit non-zero. Each call must finish within 120 s: no
experiments or grading inside the adapter.

| op | reply |
| --- | --- |
| `tasks` | `{"tasks": [{"id", "title", "supported", "reason", "tags"}]}` |
| `solve` | `{"spec": run, "issues": []}` — request has `trial` (`task`, `method`, `seed`, `options`, `staging`, `timeoutMin`) |
| `verify` | `{"spec": run}` — request adds `solve.output` (host path of the solve run's `$ORBIT_OUTPUT`) |
| `score` | `{"score": n or null, "maxScore": m, "invalid": bool, "issues": [], "review": {...}}` — request adds `verify.output` |

`run` uses `orbit run` fields: `image` or `dockerfile`, `resources`, `mounts`
(`{source, target, mode}`), `env`, `network`, `workdir`, `collect` (container paths copied to
`output/collected/<path>`), `timeoutMin`, or `backend: "process"` with `command` for a host process.

Rules:

- For `codex` / `claude-code` methods the solve spec has `"agentTask": {"instruction": "..."}` and no
  `command`. Orbit builds the Agent CLI command, auth, bundle and network. Never write Agent CLI flags.
- Never set `name group params project snapshot auth agentBundle agent parentId priority passEnv`.
- `oracle` / `empty` get a plain `command`; without a reference solution, raise an error for `oracle`.
- Writable copies and mount points go under `trial.staging` (create directories before mounting).
  The benchmark checkout stays read-only; set `PYTHONDONTWRITEBYTECODE=1` for Python.
- Give `score` a `review` so the trial page shows the right things: `files` (`label`, `phase`
  solve|verify, `path` relative to that run's output, `kind` markdown|image|text|json|table),
  `items` (graded criteria: `criterion`, `score`, `maxScore`, `weight`, `reasoning`) and short
  `details`. Never send HTML or styles; unknown kinds need a `fallback` from that list.
- `invalid: true` only when the grader itself failed (API error, internal error, unusable model). A
  method that produced nothing gets a valid 0. Cancel, timeout, not-started and out-of-memory are
  judged by Orbit.

## 3. Write the resources file

Per-task solve resources live in one JSON file next to the benchmark (for example
`<benchmark>/orbit/resources.json`, under git), registered with `--resources`. It overrides what the
adapter asks for, so the adapter can keep simple defaults.

```json
{
  "version": 1,
  "default": { "cpus": 4, "memGB": 16, "gpus": 0, "timeoutMin": 240 },
  "tasks": {
    "Material_002": {
      "gpus": 1, "gpuMemGB": 12, "memGB": 32, "timeoutMin": 360,
      "evidence": "trains a GNN on CUDA in 3 of 3 earlier runs; peak RAM 21 GB; longest 3.9 h",
      "confidence": "medium"
    }
  }
}
```

- Fields: `cpus`, `memGB` (also the hard memory limit), `gpus`, `gpuMemGB` (minimum GPU memory
  size), `timeoutMin`; `evidence`, `confidence`, `note` are for people. Unknown fields are errors.
- List only tasks that differ from `default`, and only the fields that differ.
- `gpus: 1` only when the task really trains or infers on a GPU and would not finish on CPU;
  importing torch is not evidence. Memory: generous (too little kills the run); CPU: modest (too
  little only slows it). Timeout: longest known run × 1.5, rounded up to the hour.
- Every exception carries `evidence` (what was measured or seen, where) and `confidence`.
- Evidence sources, best first: `orbit bench usage` of earlier Orbit jobs; earlier runs of the
  benchmark's own tools (durations, CUDA use in code and logs, `Killed` / exit 137, input sizes);
  the task description.

## 4. Register and validate

```bash
orbit bench add <name> <checkout> --adapter /abs/path/adapter.py \
  --resources /abs/path/resources.json [-c key=value] [--pass-env JUDGE_KEY]
orbit bench tasks <name>                         # registration already listed them once
orbit bench run <name> -t <a few tasks> -m empty -n smoke   (and -m oracle if there is one)
orbit bench show <job>                           # empty: valid 0; oracle: full score
```

Then compare a sample with the original grader on the same outputs (an LLM judge varies between
calls: measure that spread first) and report the differences to the user. Only then run real
Agent methods. Editing the adapter or the resources file needs no re-registration.

## 5. Revise resources from measured runs

Every run records peak memory, CPU and GPU memory. After jobs with real Agent methods:

```bash
orbit bench usage <job>...            # peak vs request per task, suggestions, notes
orbit bench usage <job>... --suggest  # suggested changes as a resources-file fragment
```

Suggestions are never applied automatically. Merge them into the resources file yourself when the
user agrees, keep the `evidence`, and decide GPU needs from the task (a run that did not use its GPU
may only mean the Agent chose not to train). Out-of-memory solve runs are counted invalid, not as
the method's zeros: raise the task's `memGB` and rerun those tasks.
