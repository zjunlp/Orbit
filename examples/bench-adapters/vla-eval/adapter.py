#!/usr/bin/env -S python3 -B
"""vla-eval benchmarks through Orbit adapter protocol 1 (host: Python stdlib only).

A trial is one task of a vla-eval benchmark, run as one episode in the benchmark's own image with
vla-eval's direct entry (`vla-eval run --no-docker`, the command its container uses), so the episode
loop and scoring stay upstream. A model server (a VLA policy) runs as the `policy` service with its
own GPUs; the run leases `sim` (the benchmark's container) and `policy` together (design §9.4).

Methods:
  external  `entrypoint` is the model-server **image** (`image` or `image@digest`); `config`:
            `command` (argv, JSON array), `serverConfig` (path in the image), `gpus`, `port`.
  empty     a zero-action policy served from the benchmark image itself: the benchmark runs for real
            and scores what zero actions achieve (a negative calibration, not "no model").
"""

import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

# The shared adapter SDK (examples/sdk/orbit_bench): protocol entry point and score replies.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import main as protocol_main  # noqa: E402

CONFIG = {"image", "benchmark", "episodesPerTask", "timeoutMin", "params", "policyImage"}
CONTAINER_CONFIG = "/orbit-config/vla-eval.yaml"
POLICY_PORT = 8000
# The images run `conda run -n libero` from their ENTRYPOINT; a replaced entrypoint needs the path.
CONDA = "/opt/conda/bin/conda"
SAFE = re.compile(r"^[A-Za-z0-9_.:-]+$")
HERE = Path(__file__).resolve().parent

# Runs inside the benchmark image: the task list without running an episode.
TASKS_SCRIPT = """
import json, sys

module, cls, params = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
mod = __import__(module, fromlist=[cls])
bench = getattr(mod, cls)(**params)
tasks = bench.get_tasks()
print(json.dumps([{"id": str(t.get("task_id", i)), "name": t.get("name", ""),
                   "suite": t.get("suite", "")} for i, t in enumerate(tasks)]))
"""


def settings(req):
    b = req["benchmark"]
    c = b["config"]
    unknown = set(c) - CONFIG
    if unknown:
        raise ValueError(f"Unknown vla-eval config: {', '.join(sorted(unknown))}")
    root = Path(b["path"]).resolve()
    if not (root / "src/vla_eval").is_dir():
        raise ValueError("Expected a vla-evaluation-harness checkout (src/vla_eval)")
    spec = c.get("benchmark", "")
    if not re.fullmatch(r"[A-Za-z_][\w.]*:[A-Za-z_]\w*", spec):
        raise ValueError("config `benchmark` is module:Class, e.g. "
                         "vla_eval.benchmarks.libero.benchmark:LIBEROBenchmark")
    episodes = int(c.get("episodesPerTask", "1"))
    if not 1 <= episodes <= 100:
        raise ValueError("episodesPerTask must be between 1 and 100")
    return root, c, spec, episodes


def image_of(c):
    return c.get("image", "ghcr.io/allenai/vla-evaluation-harness/libero:latest")


def params_of(c):
    return json.loads(c.get("params") or "{}")


def benchmark_in_image(image, spec, params):
    module, cls = spec.split(":")
    r = subprocess.run(
        ["docker", "run", "--rm", "--entrypoint", "bash", image, "-lc",
         'conda run --no-capture-output -n libero python -c "$0" "$@"',
         TASKS_SCRIPT, module, cls, json.dumps(params)],
        capture_output=True, text=True, timeout=600,
    )
    if r.returncode != 0:
        raise ValueError(f"benchmark image failed to list tasks: {r.stderr.strip().splitlines()[-1:][0] if r.stderr.strip() else r.returncode}")
    for line in reversed(r.stdout.strip().splitlines()):
        if line.startswith("["):
            return json.loads(line)
    raise ValueError("benchmark image printed no task list")


def tasks(req):
    _, c, spec, _ = settings(req)
    params = params_of(c)
    rows = benchmark_in_image(image_of(c), spec, params)
    return {
        "tasks": [
            {"id": f"{t['suite'] or 'task'}:{t['name']}", "title": t["name"] or None,
             "supported": True, "reason": None,
             "tags": {"suite": t["suite"], "taskIndex": t["id"]}}
            for t in rows
        ],
        "capabilities": {
            "kind": "other",
            "methods": ["external", "empty"],
            "scoreKind": "scalar",
            "rescore": "evidence",
            "conditions": {
                "Environment": image_of(c),
                "Benchmark": spec,
                "Benchmark params": json.dumps(params, sort_keys=True),
                "Episodes per task": str(int(c.get("episodesPerTask", "1"))),
                "Entry": "vla-eval run --no-docker (the command the benchmark image itself uses)",
                "Policy": "external: the model-server image as service `policy`, its own GPU; "
                          "empty: a zero-action server from the benchmark image",
            },
        },
        "metrics": [{"name": "success", "label": "Success", "unit": "%", "primary": True,
                     "description": "vla-eval's mean_success for the episode"}],
        "official": {"name": "vla-eval mean_success", "version": "1", "errors": "fail",
                     "unit": "sample"},
    }


def marshal(argv):
    """One shell command from an argv list, quoted."""
    return " ".join(shlex.quote(a) for a in argv)


def policy_service(method, image, episodes):
    if method["agent"] == "empty":
        return {
            "name": "policy", "image": image, "role": "policy", "gpus": 0,
            "entrypoint": CONDA,
            "command": ["run", "--no-capture-output", "-n", "libero", "python",
                        "/orbit-adapter/zero_policy.py", "--port", str(POLICY_PORT)],
            "cpus": 1, "memGB": 2,
            "healthcheck": {"command": ["bash", "-c", f"exec 3<>/dev/tcp/127.0.0.1/{POLICY_PORT}"],
                            "intervalSec": 5, "timeoutSec": 5, "startPeriodSec": 5, "retries": 60},
        }
    cfg = method.get("config") or {}
    entry = method.get("entrypoint", "")
    if not entry or not re.fullmatch(r"[\w./:@-]+", entry):
        raise ValueError("external methods need the model-server image as entrypoint")
    cmd = cfg.get("command")
    if isinstance(cmd, str):
        cmd = json.loads(cmd)
    if not cmd:
        raise ValueError('external methods need config command=\'["vla-eval","serve",...]\'')
    return {
        "name": "policy", "image": entry, "role": "policy",
        "gpus": int(cfg.get("gpus", "1")),
        "command": cmd,
        "cpus": int(cfg.get("cpus", "4")), "memGB": int(cfg.get("memGB", "16")),
        "healthcheck": {"command": ["bash", "-c", f"exec 3<>/dev/tcp/127.0.0.1/{POLICY_PORT}"],
                        "intervalSec": 10, "timeoutSec": 5, "startPeriodSec": 120, "retries": 120},
    }


def solve(req):
    root, c, spec, episodes = settings(req)
    t = req["trial"]
    method = t["method"]
    if method["agent"] not in ("external", "empty"):
        raise ValueError("vla-eval runs external model servers and empty; CLI Agents are not adapted")
    params = params_of(c)
    image = image_of(c)
    staging = Path(t["staging"])
    staging.mkdir(parents=True, exist_ok=True)
    server_url = f"ws://policy:{POLICY_PORT}"
    config = (
        f"server:\n  url: {json.dumps(server_url)}\n"
        "logging:\n  level: INFO\n"
        "benchmarks:\n"
        f"  - benchmark: {json.dumps(spec)}\n"
        f"    episodes_per_task: {episodes}\n"
        + ("    params:\n" + "".join(f"      {k}: {json.dumps(v)}\n" for k, v in params.items())
           if params else "")
    )
    (staging / "vla-eval.yaml").write_text(config, encoding="utf-8")
    # One task, selected by its own name (vla-eval filters tasks by suite or name, then caps the list):
    # task names are unique within a suite, and `suite` stays a fixed condition.
    name = t["task"].partition(":")[2]
    argv = [
        "run", "--no-docker", "--config", CONTAINER_CONFIG,
        "--output-dir", "/orbit/output",
        "--benchmark-field", f"episodes_per_task={episodes}",
        "--benchmark-field", f"max_tasks=1",
        "--benchmark-field", f"tasks={json.dumps([name])}",
    ]
    policy = policy_service(method, image, episodes)
    mounts = [{"source": str(staging), "target": "/orbit-config", "mode": "ro"}]
    services = [policy]
    if method["agent"] == "empty":
        services[0]["binds"] = [{"source": str(HERE / "zero_policy.py"),
                                 "target": "/orbit-adapter/zero_policy.py", "mode": "ro"}]
    return {
        "spec": {
            "image": image,
            # The image's entrypoint is `conda run -n libero vla-eval`; replace it with bash so the
            # benchmark runs through conda explicitly (the same environment as upstream).
            "entrypoint": CONDA,
            "command": ["run", "--no-capture-output", "-n", "libero", "vla-eval", *argv],
            "mounts": mounts,
            "env": {"ORBIT_VLA_CONFIG": f"/orbit-config/vla-eval.yaml"},
            # The benchmark image keeps its LIBERO config under /root/.libero; run as root like
            # Harbor does for task containers, so the image's own configuration is visible.
            "root": True,
            "resources": {"cpus": 4, "memGB": 16, "gpus": 0},
            "network": True,
            "timeoutMin": t.get("timeoutMin") or 30,
            "services": services,
        }
    }


def verify(req):
    """Scoring is part of the episode; revalidate the aggregate vla-eval wrote."""
    return {"spec": {
        "image": image_of(req["benchmark"]["config"]),
        # The benchmark image's ENTRYPOINT is `conda run vla-eval`; the check runs plain Python.
        "entrypoint": "python3",
        "command": ["/orbit-adapter/check.py", "/solve"],
        "mounts": [{"source": str(HERE / "check.py"), "target": "/orbit-adapter/check.py", "mode": "ro"},
                   {"source": req["solve"]["output"], "target": "/solve", "mode": "ro"}],
        "network": False, "resources": {"cpus": 1, "memGB": 1, "gpus": 0}, "timeoutMin": 5,
        "root": True,
    }}


def summarize(out: Path) -> dict:
    """The result vla-eval exported: mean success over the episode(s) of this trial."""
    files = sorted(out.glob("*_aggregate.json"))
    if not files:
        raise ValueError("no vla-eval aggregate json in the output")
    agg = json.loads(files[-1].read_text())
    episodes = [e for t in agg.get("tasks") or [] for e in t.get("episodes", [])]
    if not episodes:
        raise ValueError("the aggregate has no episodes")
    values = [
        float(e["metrics"]["success"])
        for e in episodes
        if (e.get("metrics") or {}).get("success") is not None
    ]
    if len(values) != len(episodes):
        raise ValueError("an episode has no success metric")
    errors = sum(1 for e in episodes if e.get("failure_reason"))
    return {
        "benchmark": agg.get("benchmark", ""),
        "episodes": len(episodes),
        "success": sum(values) / len(values),
        "errors": errors,
        "issues": [f"{errors} episode(s) errored upstream (vla-eval counts them as failures)"]
        if errors
        else [],
    }


def score(req):
    out = Path(req["solve"]["output"])
    review = {
        "files": [
            {"label": "Aggregate", "phase": "solve", "kind": "json", "path": name}
            for name in [p.name for p in sorted(out.glob("*_aggregate.json"))]
        ],
        "details": {},
    }
    try:
        body = summarize(out)
        verdict = json.loads((Path(req["verify"]["output"]) / "check.json").read_text())
        if body != verdict:
            raise ValueError("Verifier output disagrees with the saved result")
        if body["errors"]:
            # vla-eval counts infrastructure errors as failures; Orbit reports them as invalid and
            # keeps the rule's official value, so the two views stay distinguishable.
            return {
                "score": None,
                "maxScore": 1,
                "invalid": True,
                "failure": "env_step",
                "issues": body["issues"],
                "review": review,
            }
        return {
            "score": float(body["success"]),
            "maxScore": 1,
            "invalid": False,
            "issues": [],
            "metrics": {"success": 100.0 * float(body["success"])},
            "review": {**review, "details": {"benchmark": body["benchmark"],
                                             "episodes": str(body["episodes"])}},
        }
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return {
            "score": None,
            "maxScore": 1,
            "invalid": True,
            "failure": "scorer_error",
            "issues": [f"vla-eval evidence: {exc}"],
            "review": review,
        }


if __name__ == "__main__":
    sys.exit(protocol_main(tasks, solve, verify, score))
