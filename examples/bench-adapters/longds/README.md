# LongDS-Bench

External Orbit adapter for [DataMind's LongDS-Bench](https://github.com/zjunlp/DataMind/tree/main/longds).
Register the `longds/` directory of a DataMind checkout. No Orbit rebuild is needed for adapter
changes. The checkout must include the native Codex/Claude Code runners and shared `runners/src/`
judge. The adapter was developed against DataMind `a814927159470ad1624602d233f57b7c0be5882e`.

Each Orbit task is one **complete multi-turn LongDS task**, identified by
`domain/dataset/taskN`. The unmodified upstream runner starts one Docker container and reuses the
native Agent session across all turns. It sends the original prompt for the current turn only;
reference answers and future prompts stay on the host. Orbit supplies the installed Agent CLI,
auth profile and method bundle through its process backend's Docker shim. The native runner keeps
its workspace, per-turn prompts, answers, traces and metadata in the solve output.

## Prepare

Use the Orbit CLI from this checkout (`pnpm install`, then `pnpm orbit ...`, with Node 24.18+).
It includes the native Agent-home precedence fix and resource-override forwarding. Restart your own
daemon after upgrading older Orbit code, before starting Agent tasks. The examples below use
`orbit` to denote that CLI; subsequent Python adapter changes need no Orbit rebuild.

Follow the upstream [dataset and environment instructions](https://github.com/zjunlp/DataMind/blob/main/longds/README.md).
Keep the dataset outside the Orbit source checkout. Download the data for every task you intend
to run; listing reports missing task definitions/data as unsupported. No version/split fallback
or automatic turn limit is applied. Defaults are `version=v1.1`, `split=lite`; `split=full` and
older downloaded versions use their own task lists.

The host needs Python **3.11+** for the native runners, and `openai` for nonempty-answer judging.
The container uses the upstream Python 3.12 analysis environment. Build the upstream image, then
add the directories needed to run as your host UID:

```bash
python3.11 -m venv /path/to/longds-venv
/path/to/longds-venv/bin/pip install openai
docker build -t executor-prebuilt \
  /path/to/DataMind/longds/runners/DSGym/executors/container_images/longds_image
docker build -t orbit-longds \
  /path/to/Orbit/examples/bench-adapters/longds
chmod +x /path/to/Orbit/examples/bench-adapters/longds/adapter.py
```

This image uses the upstream analysis packages and NLTK assets. Agent CLIs are mounted from the
host by Orbit, so a second CLI installation in the image is unnecessary. You can provide another
prepared image, but its analysis environment becomes part of the experiment conditions. The
adapter does not silently install missing packages during tasks.

## Register and run

Create a normal Orbit Codex or Claude Code auth profile first. Configure judge credentials in the
environment of the daemon that will run these jobs. `JUDGE_API_KEY` is passed only to verify runs;
do not put it in adapter config, `--env`, shell history or the method bundle. An already-running
daemon does not inherit later shell exports; start/restart your own daemon with those variables
before submitting jobs. The judge follows upstream `JUDGE_BASE_URL` and `JUDGE_MODEL` settings
(default model: `deepseek-v4-pro`).

```bash
orbit bench add longds /path/to/DataMind/longds \
  --adapter /path/to/Orbit/examples/bench-adapters/longds/adapter.py \
  -c dataset=/path/to/LongDS \
  -c python=/path/to/longds-venv/bin/python \
  -c image=orbit-longds \
  --pass-env JUDGE_API_KEY --pass-env JUDGE_BASE_URL --pass-env JUDGE_MODEL

orbit bench tasks longds
orbit bench run longds \
  --task business/netflix_movies_and_tv_shows/task2 \
  --method sol=codex,auth=my-codex,model=gpt-6-sol,effort=low
```

Omit `--task` to select all supported tasks. Missing downloads remain listed as unsupported; check
the task count before treating a job as a complete Lite/Full evaluation. Register a separate name
with `-c split=full` or `-c version=v1` to compare datasets without changing an existing registration.
`claude-code` methods use the upstream Claude runner and forward model/effort to the native CLI.

`empty` submits a blank answer for every turn and scores zero without judge API calls. `oracle`
replays the reference answers **as a grader calibration**, not as an executable data-analysis
solution. It still calls the original LLM judge and requires judge credentials:

```bash
orbit bench run longds --task business/netflix_movies_and_tv_shows/task2 \
  --method empty --method oracle
orbit bench show JOB
orbit bench rescore JOB
```

## Scoring and retained evidence

Verify runs separately on the host and calls the original `judge_one`, prompt and output writers.
The exact unmodified judge sources and their SHA-256 hashes are saved with solve output. Rescoring
uses those saved sources, original task definitions and Agent answers; it does not rerun the Agent
or require a surviving container. It ignores any earlier evaluation and rebuilds grader ground
truth from the saved task definition. Solve output remains unchanged.

The score is the mean original binary judge score over **every turn** of that task, on 0–1 scale.
Orbit reports it as a percentage and averages equally over valid task means, matching upstream
`task_avg_score`. Missing/duplicate turns, failed Agent turns, judge API/parse errors and inconsistent
summaries are invalid. They never become successful zero-score evaluations. Check valid/invalid
counts alongside means; incomplete tasks are excluded rather than assigned zero.

Solve output contains `selection.json`, `inputs/`, `upstream/src/`, `command.json` for Agent methods,
and `native/longds_VERSION_SPLIT/orbit/domain/dataset/taskN/`. Native workspace data is removed after
successful completion by the upstream runner; generated analysis files and traces remain. Verify
output contains `task/results_with_ground_truth.json`, `task/results_eval.json`, `summary.json` and
`review.md`, with per-turn scores available on Orbit's trial page. These are private run artifacts,
not source-controlled records.

Orbit sets `CODEX_HOME` / `CLAUDE_CONFIG_DIR` to its own Agent directory so native sessions remain
available in the Run's Agent records. The upstream `codex_home/` copy and manual-resume commands
describe the runner's original home layout; they are not recovery instructions for this adapter.

## Settings and limits

| Config | Default | Meaning |
| --- | --- | --- |
| `dataset` | `<benchmark>/dataset` | Hugging Face dataset root with `task/` and `data/` |
| `version`, `split` | `v1.1`, `lite` | Exact task list and definitions |
| `image` | required for Agents | Prepared analysis image |
| `python` | `python3` | Host Python 3.11+ with `openai` |
| `cpus`, `memGB` | `4`, `16` | Solve lease and native Docker limits |
| `timeoutMin` | `1440` | Whole-task solve deadline |
| `turnTimeoutSec` | `3600` | Original runner's per-turn deadline |
| `analysisPython` | `/usr/local/bin/python` | Analysis interpreter inside Docker |
| `judgeWorkers`, `judgeRetries` | `4`, `3` | Original judge parallelism and attempts |
| `judgeTimeoutMin` | `120` | Separate verify deadline |

An Orbit resources file overrides CPU/memory and whole-task timeout before native command
planning; `bench run --timeout` wins for the whole-task deadline. The original per-turn deadline
stays independent. GPU requests are rejected: the upstream CLI runner has no GPU allocation flag.
Per-trial `--option` values are rejected, including turn-limit shortcuts.

This adapter uses the **process backend**, like Orbit's ASI wrapper. Orbit tracks its process group,
labels native Docker children, cancels/cleans them and releases resources after cleanup. The
bounded `orbit resume` failure-checkpoint feature currently supports direct local Docker Runs;
it does not recover this native runner mid-task. A daemon restart can reattach an already-running
process Run, but a failed native runner requires another solve. Kimi/Qoder/DSGym are not Orbit
harnesses and are not provided by this adapter. Real Claude model execution requires separate
validation; planning tests do not establish provider compatibility.
