---
name: orbit
description: Run experiments (training, evaluation, sweeps, any GPU job) in isolated Docker containers with Orbit, and read back their logs, metrics and outputs. Use whenever you would otherwise run a long or GPU job directly on the host, launch several seeds or hyperparameter settings, or need to check, compare or explain earlier experiment runs.
---

# Orbit: run and record experiments

Orbit runs your command in a Docker container on a snapshot of the current git repository, under a
GPU/CPU/memory lease, and keeps logs, metrics, outputs, the code diff and a link to this session.
You keep planning, editing and analysing; Orbit only executes and records. The human reviews the
runs in the Web UI (`orbit web`).

Use `orbit` instead of running experiments directly on the host, `nohup`, `tmux` or `docker run`.
Short checks (imports, a unit test, `--help`) can still run on the host.

## CLI availability

Use `orbit` when it is on PATH. Otherwise replace `orbit` in the commands below with
`npx -y @zjunlp/orbit` (requires Node.js 24.18+ in the 24.x line). No clone, build or global install
is needed. Run `doctor` before the first experiment and address any failed prerequisites.

## 1. Estimate resources before submitting

Pick the smallest request that fits; runs that cannot get resources **wait in the queue**, they do not fail.

| Flag | How to estimate |
| --- | --- |
| `--gpus N` | 0 for CPU-only work. 1 unless the code actually uses multiple GPUs (DDP, `device_map`, tensor parallel). |
| `--gpu-mem GB` | Minimum memory per GPU. Rough guide: fp16/bf16 inference ≈ 2 × params(B) GB + activations; full fine-tuning with Adam ≈ 16–20 × params(B) GB unless sharded/LoRA. |
| `--cpus N` | Data loader workers + 1–2. Default 4. |
| `--mem GB` | Host RAM: dataset held in memory + model loading peak (≈ weights size) + headroom. Default 16. |
| `--timeout MIN` | Set one for anything that could hang. |

Run `orbit resources` first to see free GPUs, their memory, active leases and the queue, on this
machine and on any worker nodes. State the estimate and its reasoning briefly to the user.
Every finished run records its measured peak memory, CPU and GPU memory (`usage` in `orbit show`):
size the next run of the same job from it instead of guessing again. A run killed for memory says
`out of memory` — raise `--mem` rather than changing the code.

With worker nodes (`orbit node ls`), Orbit places each run on any node that fits: do not pick a node
yourself unless the user asks (`--node <name>`). Runs that mount a host path (`-m`) stay on this
machine; use `-d <dataset>` for data that should be usable on every node. Logs, metrics and
`orbit show` work the same for remote runs; `orbit show` names the node.

## 2. Submit

```bash
# one run; the repository at the current directory is snapshotted into /workspace
orbit run --image pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime --gpus 1 --mem 32 \
  -n baseline -- python train.py --lr 3e-4

# a sweep: one run per combination; {key} is substituted in the command
orbit sweep --image python:3.12-slim --gpus 1 -g lr-sweep \
  -p lr=1e-4,3e-4 -p seed=1,2,3 -- python train.py --lr {lr} --seed {seed}
```

- Put all options **before** `--`; everything after `--` is the command inside the container.
- Add `--json` (before `--`) to get machine-readable output with run ids.
- `--dockerfile path/Dockerfile` builds a project image instead of `--image` (cached by content).
- Uncommitted changes and untracked files are included in the snapshot, so you do not need to commit first. Large data and weights are not copied: prefer a registered dataset, `-d <name>` (mounted read-only at `/data/<name>`; see `orbit data ls`), or mount a host path with `-m /host/path:/data` (read-only; add `:rw` only if needed).
- `-e KEY=VALUE` for non-secret environment variables, `--pass-env VAR` for secrets; `--no-network` for offline runs; `-t key=value` for tags.
- Every `run`/`sweep` is checked first (data, output disk, image, where it would start); warnings and
  failures are printed. `--check` only prints the checks. For a long or expensive run, add
  `--smoke '<short command>'` (e.g. `--smoke 'python train.py --steps 20'`): it runs first with the
  same settings, and the real run is submitted only if it succeeds.
- Use `-g <group>` for runs that belong together (sweeps, ablations) so they can be compared.
- Name every run and job for the human who reviews them: `-n` short and specific (`baseline`,
  `lr 3e-4 warmup`, `noskills xhigh random8`), groups as the question they answer (`lr-sweep`). No
  timestamps, ids or full paths in names: Orbit shows times and ids itself. Without `-n`, Orbit derives
  a name from the command (`train.py lr=3e-4`), which says what ran but not why.

## 3. Inside the container

| Path / variable | Use |
| --- | --- |
| `/workspace` | Code snapshot (writable copy; the host repo is not affected). Working directory. |
| `$ORBIT_METRICS` | Append one JSON object per line, e.g. `{"step": 100, "train/loss": 0.31, "eval/acc": 0.82}`. Use `step`; group keys with `/`. These become the curves in the Web UI. |
| `$ORBIT_OUTPUT` | Write results, predictions, plots and small checkpoints here. Kept after the run. |
| `$ORBIT_RUN_ID` | The run id. |

Print progress to stdout/stderr with `flush=True`; logs are kept in full, including for failed runs.
When the code you are writing has no metrics logging, add a few lines that write to `$ORBIT_METRICS`
if the variable is set.

## 4. Follow, wait and inspect

```bash
orbit ps                    # active runs (queued with the reason, running)
orbit ps -a -g lr-sweep     # everything in a group
orbit ps -f rcb             # everything in folder rcb (and its subfolders)
orbit mv <id...> rcb/noskills   # file runs or bench jobs in a folder (files stay where they are)
orbit wait <id>... | -g lr-sweep   # blocks; exit code 1 if any run did not succeed
orbit logs <id> --tail 4000 # end of the log; -f to follow
orbit show <id>             # state, exit code, resources and measured usage, code snapshot, metrics
orbit cancel <id>...
```

Prefer `orbit wait` over polling. For long runs, you can continue other work and check back.
When a run fails, read `orbit logs <id> --tail 8000` before changing anything; the evidence is kept.

## 5. Run an agent inside a container

When the experiment itself needs Codex or Claude Code (agent benchmarks, agent-driven data work), use a
profile the human has set up; never pass keys yourself.

```bash
orbit auth list                              # names, agent, kind; secrets are never shown
orbit auth test <profile>                    # small real run: checks that the agent answers
orbit run --image python:3.12-slim --auth <profile> -n agent-try -- \
  codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "task…"
orbit run --image python:3.12-slim --auth <profile> -- claude -p --dangerously-skip-permissions "task…"
```

The host's CLI is mounted read-only and put on `PATH`; the container is the sandbox. If no profile
fits, ask the human to add one (`orbit auth add`). Completion and failure notifications are sent to
the targets in `orbit notify list`; a group sends one summary when its last run ends.

## 6. Benchmarks

To evaluate a method on a registered benchmark, use `orbit bench`, not hand-written loops of runs:

```bash
orbit bench ls && orbit bench tasks <benchmark>          # unsupported tasks show the reason
orbit bench run <benchmark> -t <task> -m oracle -m empty -m mine=codex,auth=<profile>,model=<m> -n try
orbit bench show <job>                                   # per-method means, matrix, issues
orbit bench compare <job> <job>...                       # all-valid and paired means
orbit bench usage <job>...                               # measured peaks per task, suggestions
orbit bench rescore <job> [-t <task>] [-m <method>]      # verify + score again, no Agent rerun
```

Each trial is a solve run plus a separate verify run. Only `valid` trials count; read the issues of
`invalid` ones (environment or scorer failures, unusable model) instead of treating them as zeros.
Run `oracle` and `empty` first on a new benchmark or task set: oracle should score full, empty zero.
After a scorer or grader fix, `orbit bench rescore` re-verifies the saved solve outputs; the earlier
scores stay in each trial's history, the summary uses the latest.

To add a benchmark Orbit does not know (write an adapter, a resources file) or to size its tasks
from measured runs (`orbit bench usage`), use the `orbit-bench` skill.

### Configuration changes and evolution gates

For bundle changes, use a frozen policy and this cost order:

1. Run `orbit bench gate check-bundle /path/to/bundle --policy gate.yaml`. Address failed checks;
   absent reference hashes are `not_run`, not a claim that answer material is absent.
2. Run a small **evolve-set** smoke. Read only evolve failures to change instructions/skills;
   preserve `--parent`, `--note` and `--informed-by` references. Both content revisions must exist
   before planning. Use the same Agent/model/CLI and evaluation conditions for parent and child.
3. Run `orbit bench gate plan --policy gate.yaml --parent PARENT --child CHILD`. Review its missing,
   pending, ambiguous and blocked rows before explicitly executing a suggested command. Retain
   `--expect-revision` and `--expect-tasks-sha256`; reconcile drift instead of dropping the guards.
4. Evaluate the gate set, then the policy's frozen guard sets spanning the pilot's six-dimensional
   profiles. Select report revisions explicitly when requested; do not choose the best rescore or
   resample guards after seeing results. `orbit bench gate` saves the evidence and three-way decision.
5. After several accepted rounds, evaluate the frozen final sets and a second Agent when authorized.
   `insufficient` needs missing evidence or a revised prospective study, not an acceptance claim.

A finished job without a report may need the separate `orbit bench report JOB`; a pending job should
be allowed to finish. Neither helper submits work. Static checks are conservative pattern checks;
keep held-out task/answer material out of the bundle and keep its editor limited to evolve evidence.
Use `orbit-evolve` for the reference editing, budget and lineage workflow; editor isolation remains
a separate feature. Read the
[evolution gate guide](https://github.com/zjunlp/Orbit/blob/main/docs/guides/bench-gate.md) for policy,
report selection and command limitations.

## 7. Record conclusions

After analysing a run or a group, attach a short note so the human sees it next to the results:

```bash
orbit note <id> "lr=3e-4 converges ~2x faster than 1e-4; seed std 0.01. Next: try warmup."
```

Tell the user the run ids and `orbit web <id>` for review.

Deleting runs (`orbit rm <id>... | -g <group>`) or a bench job (`orbit bench rm-job <job>`) removes
their logs, outputs and sessions for good. Do it only when the user asks for those runs to be
deleted; the command asks the user to type the id or group, and `--yes` skips that only when the
user has explicitly confirmed this deletion.

## Rules

- Do not start experiment containers with `docker` directly, and do not stop containers or processes that Orbit or other users own; use `orbit cancel`.
- Do not request all GPUs "just in case". Do not work around the queue.
- Never put secrets in commands, tags or notes; pass them by name with `--pass-env VAR` (read from the daemon environment, never stored); `-e` values are stored with the run.
