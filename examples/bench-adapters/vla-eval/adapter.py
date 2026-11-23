#!/usr/bin/env -S python3 -B
"""vla-eval benchmarks through Orbit adapter protocol 1 (host: Python stdlib only).

A trial is one task of a vla-eval benchmark, run as one episode in the benchmark's own image with
vla-eval's direct entry (`vla-eval run --no-docker`, the command its container uses), so the episode
loop and scoring stay upstream. A model server (a VLA policy) runs as the `policy` service with its
own GPUs; the run leases `sim` (the benchmark's container) and `policy` together (design §9.4).

Methods:
  external  `entrypoint` is the model-server **image** (`image` or `image@digest`); `config`:
            `command` (argv, JSON array), `gpus`, `port`.
  empty     a zero-action policy served from the benchmark image itself: the benchmark runs for real
            and scores what zero actions achieve (a negative calibration, not "no model").
"""

from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid

from check import STRUCTURED_RECEIPT_ARG, summarize

# The shared adapter SDK (examples/sdk/orbit_bench): protocol entry point and score replies.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import main as protocol_main  # noqa: E402

# Older registrations may have policyImage. The policy runs from the method entrypoint.
CONFIG = {"image", "benchmark", "episodes", "timeoutMin", "params", "policyImage"}
LIBERO_BENCHMARK = "vla_eval.benchmarks.libero.benchmark:LIBEROBenchmark"
LIBERO_PLUS_BENCHMARK = "vla_eval.benchmarks.libero_plus.benchmark:LIBEROPlusBenchmark"
ROBOTWIN_BENCHMARK = "vla_eval.benchmarks.robotwin.benchmark:RoboTwinBenchmark"
# One trial is one episode; its seed picks the initial state (seed 1 → episode 0). This module, staged
# per trial, makes the upstream benchmark start that episode; everything else stays upstream.
EPISODE_MODULE = """import importlib

_base = getattr(importlib.import_module({module!r}), {cls!r})


class OrbitEpisode(_base):
{setup}
    async def start_episode(self, task, recorder=None):
        return await super().start_episode({{**task, "episode_idx": self.orbit_episode}}, recorder)
"""
EPISODE_SETUP = """    def __init__(self, orbit_episode: int = 0, **kw):
        super().__init__(**kw)
        self.orbit_episode = int(orbit_episode)
"""
LIBERO_EPISODE_SETUP = """    def __init__(self, orbit_episode: int = 0, orbit_task_name=None, orbit_task_id=None, **kw):
        self.orbit_task_name = orbit_task_name
        self.orbit_task_id = orbit_task_id
        super().__init__(**kw)
        self.orbit_episode = int(orbit_episode)

    def get_tasks(self):
        tasks = super().get_tasks()
        if self.orbit_task_name is None:
            return tasks
        matches = [task for task in tasks if task.get("name") == self.orbit_task_name
                   and (self.orbit_task_id is None or task.get("task_id") == self.orbit_task_id)]
        if len(matches) != 1:
            raise ValueError("LIBERO task identity is missing or ambiguous; use the current task catalog")
        return matches
"""
CONTAINER_CONFIG = "/orbit-config/vla-eval.yaml"
VERIFY_COMMAND = ("/orbit-adapter/check.py", "/solve")
POLICY_PORT = 8000
# The images run `conda run -n libero` from their ENTRYPOINT; a replaced entrypoint needs the path.
CONDA = "/opt/conda/bin/conda"
CONDA_ENVIRONMENTS = {ROBOTWIN_BENCHMARK: "robotwin"}
HERE = Path(__file__).resolve().parent

# Runs inside the benchmark image: the task list without running an episode.
TASKS_SCRIPT = """
import json, sys

module, cls, params = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
fields = json.loads(sys.argv[4]) if len(sys.argv) > 4 else []
mod = __import__(module, fromlist=[cls])
bench = getattr(mod, cls)(**params)
tasks = bench.get_tasks()
rows = []
for i, task in enumerate(tasks):
    row = {"id": str(task.get("task_id", i)), "name": task.get("name", ""), "suite": task.get("suite", "")}
    if fields:
        row["identity"] = {key: task.get(key) if type(task.get(key)) in (str, int) else None for key in fields}
    rows.append(row)
print(json.dumps(rows))
"""


def benchmark_timeout(config):
    try:
        value = float(config.get("timeoutMin", "30"))
    except ValueError as exc:
        raise ValueError("benchmark timeoutMin must be a finite positive number") from exc
    if not math.isfinite(value) or value <= 0:
        raise ValueError("benchmark timeoutMin must be a finite positive number")
    return value


def settings(req):
    b = req["benchmark"]
    c = b["config"]
    if "episodesPerTask" in c:
        raise ValueError("episodesPerTask is gone: a trial is one episode; use seeds (seed n = episode n-1)")
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
    # Initial states per task the benchmark provides (LIBERO: 50).
    episodes = int(c.get("episodes", "50"))
    if not 1 <= episodes <= 1000:
        raise ValueError("episodes must be between 1 and 1000")
    return root, c, spec, episodes


def episode_of(trial, episodes):
    """The episode (initial state) a trial runs: seed n is episode n-1."""
    seed = int(trial["seed"])
    if not 1 <= seed <= episodes:
        raise ValueError(f"seed {seed} has no episode: this benchmark has episodes 1..{episodes} per task")
    return seed - 1


def image_of(c):
    return c.get("image", "ghcr.io/allenai/vla-evaluation-harness/libero@sha256:bc9930a7e42f970bdde7f3aaddaab0c223bd8e7e922e387cd9eb48aa89ccf2f1")


def params_of(c):
    return json.loads(c.get("params") or "{}")


def benchmark_in_image(image, spec, params, fields=()):
    module, cls = spec.split(":")
    # Include the resolved image identity so a user-provided mutable tag cannot reuse stale tasks.
    image_id = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}", image],
                                       text=True, timeout=5).strip()
    cache_dir = Path(tempfile.gettempdir()) / f"orbit-vla-eval-tasks-{os.getuid()}"
    cache_dir.mkdir(mode=0o700, exist_ok=True)
    info = cache_dir.lstat()
    if cache_dir.is_symlink() or not cache_dir.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("vla-eval task cache must be a private directory owned by the current user")
    cache_key = [image_id, spec, params]
    if fields:
        cache_key.append(fields)
    digest = hashlib.sha256(json.dumps(cache_key, sort_keys=True).encode()).hexdigest()
    cache = cache_dir / (digest + ".json")
    if cache.is_file() and not cache.is_symlink():
        return json.loads(cache.read_text())
    name = "orbit-vla-eval-tasks-" + uuid.uuid4().hex
    try:
        r = subprocess.run(
            ["docker", "run", "--rm", "--name", name, "--label", "orbit.task=vla-eval-tasks",
             "--pull=never", "--network=none", "--cpus=2", "--memory=4g",
             "--entrypoint", "bash", image_id if fields else image, "-lc",
             'conda run --no-capture-output -n "$0" python -c "$@"',
             CONDA_ENVIRONMENTS.get(spec, "libero"), TASKS_SCRIPT, module, cls, json.dumps(params),
             *([json.dumps(fields)] if fields else [])],
            capture_output=True, text=True, timeout=75,
        )
    except subprocess.TimeoutExpired as exc:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=10)
        raise ValueError("vla-eval task discovery timed out") from exc
    if r.returncode != 0:
        raise ValueError(f"benchmark image failed to list tasks: {r.stderr.strip().splitlines()[-1:][0] if r.stderr.strip() else r.returncode}")
    for line in reversed(r.stdout.strip().splitlines()):
        if line.startswith("["):
            rows = json.loads(line)
            temporary = cache.with_name(name + ".partial")
            try:
                with temporary.open("x", encoding="utf8") as output:
                    json.dump(rows, output)
                temporary.replace(cache)
            finally:
                temporary.unlink(missing_ok=True)
            return rows
    raise ValueError("benchmark image printed no task list")


def benchmark_identity(spec):
    if spec == LIBERO_BENCHMARK:
        return {"id": "libero", "name": "LIBERO", "variant": "vla-eval"}
    return {"id": "vla-" + hashlib.sha256(spec.encode()).hexdigest()[:16],
            "name": spec, "variant": "vla-eval"}


def planned_task(task, benchmark):
    suite, _, name = task.partition(":")
    indexed = re.fullmatch(r"@([0-9]+):(.+)", name) if benchmark in (LIBERO_BENCHMARK, LIBERO_PLUS_BENCHMARK) else None
    return suite, indexed[2] if indexed else name, int(indexed[1]) if indexed else None


def benchmark_identity_fields(config, spec):
    return ("seed",) if spec == ROBOTWIN_BENCHMARK else ()


def robotwin_scenes(rows, fields):
    groups = {}
    for row in rows:
        seed = row.get("identity", {}).get("seed")
        task = f"{row['suite']}:{row['name']}"
        scenes = groups.setdefault(task, {})
        if type(seed) is not int or seed < 0:
            raise ValueError(f"RoboTwin task {task!r} requires a nonnegative native scene seed")
        if seed in scenes:
            raise ValueError(f"duplicate RoboTwin scene seed {seed} for {task!r}")
        scenes[seed] = row["identity"]
    return groups


def robotwin_scene_seeds(task, scenes, raw):
    candidates = scenes.get(task)
    if not candidates:
        raise ValueError(f"RoboTwin task {task!r} is absent from the current catalog")
    if raw is None:
        return sorted(candidates)
    try:
        seeds = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("sceneSeeds must be a JSON array of native RoboTwin scene seeds") from exc
    if (
        not isinstance(seeds, list) or not seeds
        or any(type(seed) is not int or seed not in candidates for seed in seeds)
        or len(set(seeds)) != len(seeds)
    ):
        raise ValueError(f"sceneSeeds must list distinct native scene seeds from RoboTwin task {task!r}")
    return seeds


def tasks(req):
    _, c, spec, _ = settings(req)
    benchmark_timeout(c)
    params = params_of(c)
    fields = benchmark_identity_fields(c, spec)
    rows = benchmark_in_image(image_of(c), spec, params, fields)
    names = Counter((row["suite"], row["name"]) for row in rows)
    listing = []
    for row in rows:
        suite, name = row["suite"], row["name"]
        if spec in (LIBERO_BENCHMARK, LIBERO_PLUS_BENCHMARK) and names[suite, name] > 1:
            identifier = f"{suite}:@{row['id']}:{name}"
        else:
            identifier = f"{suite or 'task'}:{name}"
        listing.append({"id": identifier, "title": name or None,
                        "supported": True, "reason": None,
                        "tags": {"suite": suite, "taskIndex": row["id"]}})
    return {
        "tasks": listing,
        "validateSeedSubmission": True,
        "capabilities": {
            # A fixed policy closes the loop with the simulator, one episode per trial; a still
            # policy can satisfy a goal that holds at the start.
            "identity": benchmark_identity(spec),
            "taxonomy": {"domains": ["robotics"]},
            "calibration": {"empty": "any", "oracle": "none", "seedsVary": True},
            "methods": ["external", "empty"],
            "scoreKind": "scalar",
            "rescore": "evidence",
            "conditions": {
                "Environment": image_of(c),
                "Benchmark": spec,
                "Benchmark params": json.dumps(params, sort_keys=True),
                "Episode": "one per trial; seed n runs the benchmark's initial state n-1 "
                           f"(1..{int(c.get('episodes', '50'))})",
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


def policy_service(method, image, port):
    if method["agent"] == "empty":
        return {
            "name": "policy", "image": image, "role": "policy", "gpus": 0,
            "entrypoint": CONDA,
            "command": ["run", "--no-capture-output", "-n", "libero", "python",
                        "/orbit-adapter/zero_policy.py", "--port", str(port)],
            "cpus": 1, "memGB": 2,
            "healthcheck": {"command": ["bash", "-c", f"exec 3<>/dev/tcp/127.0.0.1/{port}"],
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
        "healthcheck": {"command": ["bash", "-c", f"exec 3<>/dev/tcp/127.0.0.1/{port}"],
                        "intervalSec": 10, "timeoutSec": 5, "startPeriodSec": 120, "retries": 120},
    }


def solve(req):
    root, c, spec, episodes = settings(req)
    t = req["trial"]
    method = t["method"]
    episode = episode_of(t, episodes)
    if method["agent"] not in ("external", "empty"):
        raise ValueError("vla-eval runs external model servers and empty; CLI Agents are not adapted")
    timeout_min = t.get("timeoutMin")
    if timeout_min is None:
        timeout_min = benchmark_timeout(c)
    params = params_of(c)
    image = image_of(c)
    staging = Path(t["staging"])
    staging.mkdir(parents=True, exist_ok=True)
    method_config = method.get("config") or {}
    port = int(method_config.get("port", POLICY_PORT))
    if not 1 <= port <= 65535:
        raise ValueError("policy port must be between 1 and 65535")
    server_url = f"ws://policy:{port}"
    module, cls = spec.split(":")
    suite, name, task_id = planned_task(t["task"], spec)
    select_libero_task = spec == LIBERO_BENCHMARK or task_id is not None
    setup = LIBERO_EPISODE_SETUP if select_libero_task else EPISODE_SETUP
    (staging / "orbit_episode.py").write_text(
        EPISODE_MODULE.format(module=module, cls=cls, setup=setup), encoding="utf-8")
    params = {**params, "orbit_episode": episode}
    if select_libero_task:
        if params.get("suite", "libero_spatial") != suite:
            raise ValueError("planned task suite differs from the configured LIBERO suite")
        params.update(orbit_task_name=name, orbit_task_id=task_id)
    config = (
        f"server:\n  url: {json.dumps(server_url)}\n"
        "logging:\n  level: INFO\n"
        "benchmarks:\n"
        "  - benchmark: \"orbit_episode:OrbitEpisode\"\n"
        "    episodes_per_task: 1\n"
        "    params:\n" + "".join(f"      {k}: {json.dumps(v)}\n" for k, v in params.items())
    )
    (staging / "vla-eval.yaml").write_text(config, encoding="utf-8")
    # Upstream's name filter still applies after the LIBERO wrapper selects a native task.
    argv = [
        "run", "--no-docker", "--config", CONTAINER_CONFIG,
        "--output-dir", "/orbit/output",
        "--benchmark-field", "episodes_per_task=1",
        "--benchmark-field", f"max_tasks=1",
        "--benchmark-field", f"tasks={json.dumps([name])}",
    ]
    policy = policy_service(method, image, port)
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
            "env": {"ORBIT_VLA_CONFIG": "/orbit-config/vla-eval.yaml", "PYTHONPATH": "/orbit-config"},
            # The benchmark image keeps its LIBERO config under /root/.libero; run as root like
            # Harbor does for task containers, so the image's own configuration is visible.
            "root": True,
            "resources": {"cpus": 4, "memGB": 16, "gpus": 0},
            "network": True,
            "timeoutMin": timeout_min,
            "dependsOn": ["policy"],
            "services": services,
        }
    }


def verify(req):
    """Scoring is part of the episode; revalidate the aggregate vla-eval wrote."""
    config = req["benchmark"]["config"]
    spec = config.get("benchmark")
    suite, _, task_id = planned_task(req["trial"]["task"], spec)
    identity = [suite] if spec == LIBERO_BENCHMARK or task_id is not None else [STRUCTURED_RECEIPT_ARG]
    if task_id is not None:
        identity.append(str(task_id))
    return {"spec": {
        "image": image_of(req["benchmark"]["config"]),
        # The benchmark image's ENTRYPOINT is `conda run vla-eval`; the check runs plain Python.
        "entrypoint": "python3",
        "command": [*VERIFY_COMMAND, *identity],
        "mounts": [{"source": str(HERE / "check.py"), "target": "/orbit-adapter/check.py", "mode": "ro"},
                   {"source": req["solve"]["output"], "target": "/solve", "mode": "ro"}],
        "network": False, "resources": {"cpus": 1, "memGB": 1, "gpus": 0}, "timeoutMin": 5,
        "root": True,
    }}


FAILURE_REASON = {
    "model_start": "policy_start",
    "model_act": "policy_act",
    "env_start": "reset_failed",
    "server_unreachable": "server_unreachable",
    "connection_closed": "server_unreachable",
    "timeout": "call_watchdog",
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
        _, _, spec, episodes = settings(req)
        suite, name, task_id = planned_task(req["trial"]["task"], spec)
        body = summarize(out, suite=suite if spec == LIBERO_BENCHMARK or task_id is not None else None, task_id=task_id)
        verification = req["verify"]
        verdict = json.loads((Path(verification["output"]) / "check.json").read_text())
        verifier_spec = verification.get("run", {}).get("spec", {})
        expected = body
        if task_id is None and verifier_spec.get("command") == list(VERIFY_COMMAND):
            trial = req["trial"]
            params = verifier_spec.get("params", {})
            solve_mounts = [mount for mount in verifier_spec.get("mounts", []) if mount.get("target") == "/solve"]
            if (params.get("task"), params.get("method"), params.get("seed")) != (
                    trial["task"], trial["method"]["name"], str(trial["seed"])) or solve_mounts != [
                        {"source": req["solve"]["output"], "target": "/solve", "mode": "ro"}]:
                raise ValueError("Verifier Run belongs to another trial or Solve output")
            expected = dict(body)
            expected.pop("aggregateDigest", None)
            # Old receipts recorded the reason in issues only. Keep that exact comparison.
            if "failureReason" not in verdict:
                expected.pop("failureReason", None)
        if expected != verdict:
            raise ValueError("Verifier output disagrees with the saved result")
        planned = episode_of(req["trial"], episodes)
        if body["episode"] != planned or body["task"] != name:
            raise ValueError(f"ran {body['task']!r} episode {body['episode']}, planned episode {planned}")
        episode = {"steps": body["steps"], "endedBy": "success" if body["success"] else "horizon"}
        if body["errors"]:
            # vla-eval counts infrastructure errors as failures; Orbit reports them as invalid and
            # keeps the rule's official value, so the two views stay distinguishable.
            return {
                "score": None,
                "maxScore": 1,
                "invalid": True,
                "failure": FAILURE_REASON.get(body["failureReason"], "env_step"),
                "issues": body["issues"],
                "review": review,
            }
        return {
            "score": float(body["success"]),
            "maxScore": 1,
            "invalid": False,
            "issues": [],
            "metrics": {"success": 100.0 * float(body["success"])},
            "episode": episode,
            "review": {**review, "details": {"benchmark": body["benchmark"],
                                             "initial state": str(body["episode"]),
                                             "steps": str(body["steps"])}},
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


def validate_seed_submission(req):
    _, config, spec, episodes = settings(req)
    submission = req["seedSubmission"]
    count = submission["seeds"]
    episode_of({"seed": count}, episodes)
    if spec == ROBOTWIN_BENCHMARK:
        fields = benchmark_identity_fields(config, spec)
        rows = benchmark_in_image(image_of(config), spec, params_of(config), fields)
        scenes = robotwin_scenes(rows, fields)
        raw = submission["options"].get("sceneSeeds")
        for task in submission["tasks"]:
            seeds = robotwin_scene_seeds(task, scenes, raw)
            if raw is not None and len(seeds) != count:
                raise ValueError(f"sceneSeeds length must match --seeds {count}; got {len(seeds)}")
            if len(seeds) < count:
                raise ValueError(f"requested {count} trials for RoboTwin task {task!r}, but only "
                                 f"{len(seeds)} scenes are available")
    return {"ok": True}


if __name__ == "__main__":
    sys.exit(protocol_main(tasks, solve, verify, score, validate_seed_submission=validate_seed_submission))
