#!/usr/bin/env python3
"""Orbit bench adapter for PostTrainBench (adapter protocol 1).

PostTrainBench measures how far an agent can post-train a small base model
(Qwen3-1.7B-Base by default) on a benchmark (GSM8K / HumanEval / GPQA / AIME /
BFCL / Arena-Hard / HealthBench) within a fixed time budget on one GPU. This
adapter registers PostTrainBench as an Orbit benchmark so a task x method x seed
sweep is a single `orbit bench run`.

Register:

  orbit bench add ptb /path/to/PostTrain_Agent \\
    --adapter /path/to/examples/bench-adapters/posttrainbench/adapter.py \\
    --resources /path/to/PostTrain_Agent/orbit/resources.json \\
    --pass-env OPENAI_API_KEY        # only the writing benchmarks need it

The solve run executes inside the ptb-solve image with the same directory
contract as PostTrainBench's own run_task.sh / run_local.sh: the workspace holds
evaluate.py, templates/, timer.sh, and the decontamination tools
(contamination_check.py, test_data.json) sit in its parent directory. Agent
methods (codex / claude-code) use `agentTask`, which lets Orbit launch the CLI
with the prompt from get_prompt.py; the native harness (my_pt_agent) uses
`command` to run its solve.sh directly. `final_model/` is collected on exit.

The verify run re-runs the task's evaluate.py against the collected model and
writes metrics.json; score is accuracy x 100. A solve that produced no
final_model (the `empty` method) scores a valid 0; a crashed evaluate.py is
invalid. PostTrainBench has no reference solution, so `oracle` is refused.

Config keys (`orbit bench add -c KEY=VALUE`), all optional:

  image          solve image (default: orbit-local/ptb-solve:latest)
  verifyImage    verify image (default: the solve image)
  cpus, memGB, gpus, gpuMemGB, timeoutMin
                 solve resources (default: 8, 64, 1, 80, 660)
  modelToTrain   base model to post-train (default: Qwen/Qwen3-1.7B-Base)
  numHours       time budget passed to get_prompt.py and timer.sh (default: 10)
  numGpus        GPU count passed to get_prompt.py (default: 1)
  hfHome         HuggingFace cache on the host
                 (default: $HF_HOME, else ~/.cache/huggingface)
  cudaCompat     directory of CUDA forward-compatibility libraries, mounted into
                 the container when it exists, so a pre-CUDA-13 driver can still
                 run the cu130 wheels (default: /usr/local/cuda-13.0/compat)
  proxy          HTTP(S) proxy for the container, e.g. http://172.17.0.1:7890
                 for a proxy listening on the Docker bridge gateway
                 (default: none; containers reach the network directly)
"""

import json
from pathlib import Path
import os
import shutil
import subprocess
import sys

# The shared adapter SDK (examples/sdk/orbit_bench): protocol entry point and score replies.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import main as protocol_main  # noqa: E402

HERE = os.path.dirname(os.path.realpath(__file__))
# Orbit reserves /workspace (code snapshot) and /orbit (metrics and outputs), so
# mount targets must avoid both. /task is the workspace, /repo the read-only
# PostTrainBench checkout, /hf-cache the HuggingFace cache, /env the config file.
WORKSPACE = "/task"
NATIVE_WORKSPACE = "/home/ben/task"
REPO_DIR = "/repo"
HF_DIR = "/hf-cache"
ENV_DIR = "/env"
DEFAULT_MODEL = "Qwen/Qwen3-1.7B-Base"
DEFAULT_HOURS = "10"
DEFAULT_IMAGE = "orbit-local/ptb-solve:latest"

# PostTrainBench publishes no leaderboard reference score, so `range` is the only
# bound we can state; jobs fill in what is achievable.
METRICS = [
    {
        "name": "score",
        "label": "Score",
        "unit": "%",
        "range": [0, 100],
        "description": "evaluate.py accuracy x 100",
        "primary": True,
    },
]


def config(req, key, default):
    return req["benchmark"]["config"].get(key, default)


def is_native(req):
    method = req["trial"]["method"]
    return method["agent"] == "empty" and method.get("name") == "native"


def collected_model_dir(req):
    workspace = NATIVE_WORKSPACE if is_native(req) else WORKSPACE
    return os.path.join(req["solve"]["output"], "collected",
                        workspace.lstrip("/"), "final_model")


# `category` / `profiles` are deprecated compatibility fields (design §9.10).
CAPABILITIES = {"identity": {"id": "posttrainbench", "name": "PostTrainBench"}, "domains": ["machine-learning"], "category": "agent-workspace", "profiles": ["ml-experiment"], "kind": "other", "methods": ["cli", "empty"], "scoreKind": "scalar", "rescore": "evidence", "calibration": {"oracle": "none"}, "conditions": {"Scoring": "evaluate.py on the final_model the Agent trained"}}


def tasks_dir(req):
    return os.path.join(req["benchmark"]["path"], "src", "eval", "tasks")


def task_dir(req, task):
    return os.path.join(tasks_dir(req), task)


def read_info(req, task):
    """The task's info.json (benchmark name, required_api_keys), or {}."""
    try:
        with open(os.path.join(task_dir(req, task), "info.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def tasks(req):
    """Every directory under src/eval/tasks with evaluate.py, benchmark.txt and info.json.

    PostTrainBench currently ships eight: gsm8k, humaneval, gpqamain, aime2025,
    aime2026, arenahardwriting, bfcl and healthbench.
    """
    root = tasks_dir(req)
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return {"tasks": [], "metrics": METRICS}
    out = []
    for tid in names:
        d = os.path.join(root, tid)
        if not os.path.isdir(d):
            continue
        problems = [
            f"{name} missing"
            for name in ("evaluate.py", "benchmark.txt", "info.json")
            if not os.path.isfile(os.path.join(d, name))
        ]
        title = None
        if not problems:
            try:
                with open(os.path.join(d, "benchmark.txt"), encoding="utf-8") as f:
                    title = f.read().strip()
            except OSError:
                pass
        tags = {}
        info = read_info(req, tid) if not problems else {}
        if info.get("benchmark"):
            tags["benchmark"] = info["benchmark"]
        out.append({
            "id": tid,
            "title": title,
            "supported": not problems,
            "reason": "; ".join(problems) or None,
            "tags": tags,
        })
    return {"tasks": out, "metrics": METRICS, "capabilities": CAPABILITIES}


def get_prompt(req, task):
    """The agent instruction from PostTrainBench's get_prompt.py.

    It is a plain string substitution over src/eval/general/prompt.txt, so it
    needs nothing from the PostTrainBench runtime beyond being run from the repo
    root (it resolves its template through relative paths).
    """
    repo = req["benchmark"]["path"]
    agent = req["trial"]["method"].get("name", "claude-code")
    # A method name may carry options after '='; get_prompt.py wants the bare name.
    agent = agent.split("=", 1)[0]
    try:
        r = subprocess.run(
            [
                "python3", "src/eval/general/get_prompt.py",
                "--agent", agent,
                "--model-to-train", config(req, "modelToTrain", DEFAULT_MODEL),
                "--benchmark-id", task,
                "--num-hours", config(req, "numHours", DEFAULT_HOURS),
                "--num-gpus", str(config(req, "numGpus", "1")),
            ],
            cwd=repo, capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        raise RuntimeError(f"get_prompt.py failed: {e}") from e
    if r.returncode != 0:
        raise RuntimeError(f"get_prompt.py exited {r.returncode}: {r.stderr[:300]}")
    return r.stdout


def create_timer(req, staging_task):
    """Write timer.sh, the workspace's only source of truth for remaining time.

    PostTrainBench's run_task.sh calls src/utils/create_timer.sh <hours> <out>;
    native harnesses read the resulting timer.sh to decide when to stop.
    """
    repo = req["benchmark"]["path"]
    script = os.path.join(repo, "src", "utils", "create_timer.sh")
    out = os.path.join(staging_task, "timer.sh")
    if os.path.isfile(script):
        try:
            subprocess.run(["bash", script, config(req, "numHours", DEFAULT_HOURS), out],
                           check=True, timeout=10)
            return
        except (subprocess.CalledProcessError, OSError, subprocess.TimeoutExpired):
            pass
    _fallback_timer(config(req, "numHours", DEFAULT_HOURS), out)


def _fallback_timer(hours, out):
    """create_timer.sh alternative: print minutes left until a fixed deadline."""
    import time

    end = time.time() + float(hours) * 3600
    with open(out, "w") as f:
        f.write("#!/bin/bash\n")
        f.write("echo $(( (%d - $(date +%%s)) / 60 ))\n" % int(end))


def copy_task_contract(req, task, staging_task):
    """Lay out the workspace exactly as run_task.sh / run_local.sh do.

    Into the workspace (the container's working directory):
      evaluate.py, templates/, evaluation_code/ and task_context/* come from the
      task directory and src/eval/templates; timer.sh from create_timer.sh.

    Into its parent (the decontamination contract reads ../contamination_check.py
    and ../test_data.json):
      contamination_check.py and the task's test_data.json.
    """
    repo = req["benchmark"]["path"]
    src_task = task_dir(req, task)
    shutil.copy(os.path.join(src_task, "evaluate.py"),
                os.path.join(staging_task, "evaluate.py"))
    tmpl_src = os.path.join(repo, "src", "eval", "templates")
    if os.path.isdir(tmpl_src):
        shutil.copytree(tmpl_src, os.path.join(staging_task, "templates"),
                        dirs_exist_ok=True)
    ec = os.path.join(src_task, "evaluation_code")
    if os.path.isdir(ec):
        shutil.copytree(ec, os.path.join(staging_task, "evaluation_code"),
                        dirs_exist_ok=True)
    tc = os.path.join(src_task, "task_context")
    if os.path.isdir(tc):
        # run_task.sh flattens task_context/* into the workspace.
        for name in os.listdir(tc):
            s = os.path.join(tc, name)
            d = os.path.join(staging_task, name)
            if os.path.isdir(s):
                shutil.copytree(s, d, dirs_exist_ok=True)
            else:
                shutil.copy2(s, d)
    create_timer(req, staging_task)

    parent = os.path.dirname(staging_task)
    decontam = os.path.join(repo, "src", "judges", "judge_tools", "contamination_check.py")
    if os.path.isfile(decontam):
        shutil.copy(decontam, os.path.join(parent, "contamination_check.py"))
    test_data = os.path.join(src_task, "test_data.json")
    if os.path.isfile(test_data):
        shutil.copy(test_data, os.path.join(parent, "test_data.json"))


def hf_cache_mounts(req, hf_home):
    """Mounts for the HuggingFace cache.

    Weights stay read-only, but the datasets cache is mounted writable because
    `datasets` takes a file lock there even in offline mode. When the cache has
    no datasets directory the whole cache is writable, since there is nothing to
    protect separately.
    """
    if not os.path.isdir(hf_home):
        return []
    datasets = os.path.join(hf_home, "datasets")
    if os.path.isdir(datasets):
        return [
            {"source": hf_home, "target": HF_DIR, "mode": "ro"},
            {"source": datasets, "target": f"{HF_DIR}/datasets", "mode": "rw"},
        ]
    return [{"source": hf_home, "target": HF_DIR, "mode": "rw"}]


def solve(req):
    trial = req["trial"]
    agent = trial["method"]["agent"]
    native = is_native(req)
    if agent == "oracle":
        raise ValueError(
            "PostTrainBench has no reference solution: the model is what gets "
            "trained, so no final_model can be staged. Use empty (adapter check) "
            "or an agent method (codex / claude-code / native harness)."
        )
    task = trial["task"]
    ws = os.path.join(trial["staging"], "task")
    os.makedirs(ws, exist_ok=True)
    copy_task_contract(req, task, ws)

    repo = req["benchmark"]["path"]
    hf_home = config(req, "hfHome",
                     os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface")))
    image = config(req, "image", None) or DEFAULT_IMAGE

    # Mounts shared by every method. The workspace entry is replaced below for the
    # native harness, which needs its parent directory instead.
    mounts = [
        {"source": ws, "target": WORKSPACE, "mode": "rw"},
        {"source": repo if native else os.path.join(repo, "src"),
         "target": REPO_DIR if native else f"{REPO_DIR}/src", "mode": "ro"},
    ]
    mounts += hf_cache_mounts(req, hf_home)

    # A driver older than CUDA 13 needs these forward-compatibility libraries to
    # run the cu130 wheels; they are absent on hosts that do not need them.
    cuda_compat = config(req, "cudaCompat", "/usr/local/cuda-13.0/compat")
    has_compat = bool(cuda_compat) and os.path.isdir(cuda_compat)
    if has_compat:
        mounts.append({"source": cuda_compat, "target": "/cuda-compat", "mode": "ro"})

    env = {
        "HF_HOME": HF_DIR,
        "HF_HUB_OFFLINE": "1",
        "HF_DATASETS_OFFLINE": "1",
        "NUM_GPUS": str(config(req, "numGpus", "1")),
        "VLLM_API_KEY": "inspectai",
        "PYTHONNOUSERSITE": "1",
        "TOKENIZERS_PARALLELISM": "false",
        "TMPDIR": "/tmp",
    }
    if has_compat:
        env["LD_LIBRARY_PATH"] = "/cuda-compat:/usr/local/lib"
    # Off by default: hosts either reach the network directly or front it with a
    # proxy the operator names. A Docker bridge gateway proxy looks like
    # `-c proxy=http://172.17.0.1:7890`.
    proxy = config(req, "proxy", "")
    if proxy:
        env.update({
            "HTTP_PROXY": proxy, "HTTPS_PROXY": proxy,
            "http_proxy": proxy, "https_proxy": proxy,
            "NO_PROXY": "localhost,127.0.0.1", "no_proxy": "localhost,127.0.0.1",
        })
    # The decision layer of a native harness reads its keys from a dotenv file.
    if native:
        agent_env = os.environ.get("AGENT_ENV", os.path.join(repo, ".env"))
        if os.path.isfile(agent_env):
            mounts.append({"source": agent_env, "target": f"{ENV_DIR}/.env", "mode": "ro"})
            env["AGENT_ENV"] = f"{ENV_DIR}/.env"

    spec = {
        "resources": {
            "cpus": float(config(req, "cpus", "8")),
            "memGB": float(config(req, "memGB", "64")),
            "gpus": int(config(req, "gpus", "1")),
            "gpuMemGB": float(config(req, "gpuMemGB", "80")),
        },
        "mounts": mounts,
        "env": env,
        "workdir": WORKSPACE,
        "network": True,  # agents may download data and call their model API
        "timeoutMin": trial.get("timeoutMin") or float(config(req, "timeoutMin", "660")),
        "collect": [f"{WORKSPACE}/final_model"],
        "image": image,
    }

    if native:
        # Native harness: run the agent's own solve.sh. It cd's to /home/ben/task,
        # so the staging parent becomes the container home and the workspace
        # contract (with its parent) is preserved.
        env["PROMPT"] = get_prompt(req, task)
        spec["mounts"] = [
            {"source": os.path.dirname(ws), "target": "/home/ben", "mode": "rw"},
            *mounts[1:],
        ]
        spec["workdir"] = NATIVE_WORKSPACE
        spec["collect"] = [f"{NATIVE_WORKSPACE}/final_model"]
        spec["command"] = ["sh", "-c",
            "ln -sfn /repo/agents/my_pt_agent/src /home/ben/task/src; "
            "unset ANTHROPIC_AUTH_TOKEN; "
            "[ -f /env/.env ] && { set -a; . /env/.env; set +a; }; "
            "bash /repo/agents/my_pt_agent/solve.sh"
        ]
    elif agent in ("codex", "claude-code"):
        spec["agentTask"] = {"instruction": get_prompt(req, task)}
        # An agent may fetch extra training data, so it gets the network rather
        # than the cache-only defaults above.
        env["HF_HUB_OFFLINE"] = "0"
        env["HF_DATASETS_OFFLINE"] = "0"
        # The prompt points at ../test_data.json and ../contamination_check.py,
        # which from /task means the container root.
        parent = os.path.dirname(ws)
        for name in ("test_data.json", "contamination_check.py"):
            p = os.path.join(parent, name)
            if os.path.isfile(p):
                mounts.append({"source": p, "target": f"/{name}", "mode": "ro"})
    else:
        # `empty`: no work, no output. The score op turns the missing final_model
        # into a valid zero, which is what checks the adapter without a model.
        spec["command"] = ["true"]
    return {"spec": spec}


def verify(req):
    """Run the task's evaluate.py in a GPU container against the collected model.

    evaluate.py takes --model-path, --json-output-file and --templates-dir, and
    writes an accuracy between 0 and 1 to the output file.
    """
    trial = req["trial"]
    task = trial["task"]
    repo = req["benchmark"]["path"]
    solve_output = req["solve"]["output"]
    image = config(req, "verifyImage", None) or config(req, "image", None) or DEFAULT_IMAGE

    # Rebuild the contract rather than reuse the solve run's staging: a rescore
    # may run after that staging directory has been cleaned up.
    staging = trial.get("staging", "")
    verify_ws = os.path.join(staging, "verify-task") if staging else None
    if verify_ws:
        os.makedirs(verify_ws, exist_ok=True)
        copy_task_contract(req, task, verify_ws)
        eval_py, tmpl_dir = f"{WORKSPACE}/evaluate.py", f"{WORKSPACE}/templates"
    else:
        eval_py = f"{REPO_DIR}/src/eval/tasks/{task}/evaluate.py"
        tmpl_dir = f"{REPO_DIR}/src/eval/templates"

    mounts = [{"source": repo, "target": REPO_DIR, "mode": "ro"}]
    if verify_ws:
        mounts.append({"source": verify_ws, "target": WORKSPACE, "mode": "ro"})
    hf_home = config(req, "hfHome",
                     os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface")))
    if os.path.isdir(hf_home):
        mounts.append({"source": hf_home, "target": HF_DIR, "mode": "ro"})
    mounts.append({"source": solve_output, "target": "/solve-out", "mode": "ro"})
    model_in_container = "/solve-out/" + os.path.relpath(collected_model_dir(req), solve_output)

    proxy = config(req, "proxy", "")
    env = {"PYTHONNOUSERSITE": "1", "HF_HUB_OFFLINE": "1"}
    if proxy:
        env.update({
            "HTTP_PROXY": proxy, "HTTPS_PROXY": proxy,
            "http_proxy": proxy, "https_proxy": proxy,
            "NO_PROXY": "localhost,127.0.0.1", "no_proxy": "localhost,127.0.0.1",
        })

    return {"spec": {
        "resources": {"gpus": 1, "gpuMemGB": 80, "cpus": 4, "memGB": 32},
        "mounts": mounts,
        "env": env,
        "workdir": WORKSPACE,
        "network": True,  # the writing benchmarks grade through an API
        "timeoutMin": 60,
        "image": image,
        "command": ["sh", "-c",
                    f'python {eval_py} --model-path "{model_in_container}" '
                    f'--json-output-file "$ORBIT_OUTPUT/metrics.json" '
                    f'--templates-dir "{tmpl_dir}" --limit 100'],
    }}


def score(req):
    """score = accuracy x 100 from metrics.json.

    A solve that produced no final_model (the `empty` method) is a valid zero:
    producing nothing is the method's result, not a broken environment. A verify
    that wrote no metrics.json is invalid, since the evaluation itself failed.
    """
    def bad(issue):
        return {"score": None, "maxScore": 100, "invalid": True, "issues": [issue]}

    final_model = collected_model_dir(req)
    if not os.path.isdir(final_model):
        return {"score": 0, "maxScore": 100, "invalid": False,
                "issues": ["no final_model produced"], "metrics": {}}

    metrics_file = os.path.join(req["verify"]["output"], "metrics.json")
    if not os.path.isfile(metrics_file):
        return bad("verify wrote no metrics.json (evaluate.py crashed?)")
    try:
        with open(metrics_file, encoding="utf-8") as f:
            m = json.load(f)
    except ValueError:
        return bad("metrics.json is not valid JSON")
    acc = m.get("accuracy")
    if not isinstance(acc, (int, float)):
        return bad(f"metrics.json has no numeric accuracy: {m}")
    return {"score": round(acc * 100, 4), "maxScore": 100, "invalid": False,
            "issues": [], "metrics": {}}


if __name__ == "__main__":
    sys.exit(protocol_main(tasks, solve, verify, score))
