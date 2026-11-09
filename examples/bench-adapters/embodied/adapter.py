#!/usr/bin/env -S python3 -B
"""Orbit protocol 1 adapter: native environments, independent policy, one planned episode."""

import ast
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

HERE = Path(__file__).resolve().parent
SDK = HERE.parents[1] / "sdk"
sys.path.insert(0, str(SDK))
from orbit_bench import invalid, main, pinned, valid
from orbit_embodied import digest, resolve_binding
from orbit_embodied.binding import GENERATED_ENVIRONMENTS, check_distinct_resets, check_sample, file_digest, reset_seed, seed_asset
from orbit_embodied.libero_plus import PERTURBATIONS, catalog as libero_plus_catalog, metric_name
from orbit_embodied.simpler import initial_state_count, scene_at
from orbit_embodied.vlabench import METRICS as VLABENCH_METRICS, initial_state_count as vlabench_state_count


CALVIN_COMPLETED_SUBTASKS = "completed_subtasks"


def check_source(root, source, files):
    commit = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if commit != source["commit"]:
        raise ValueError("unexpected source revision for " + source["repository"])
    for name, expected in files.items():
        if file_digest(root / name) != expected:
            raise ValueError("reference source changed: " + name)


def implementation_digest():
    files = {"adapter.py": file_digest(HERE / "adapter.py"), "run.py": file_digest(HERE / "run.py")}
    for path in sorted((SDK / "orbit_embodied").glob("*.py")):
        if not path.name.startswith("test_"):
            files["sdk/" + path.name] = file_digest(path)
    return digest(files)


def reference_profile(config):
    reference = json.loads(config.get("reference") or (HERE / "reference.json").read_text())
    if config.get("profileDigest") != digest(reference):
        raise ValueError("register the exact reference profileDigest; floating profiles are not allowed")
    return reference


def settings(req):
    config = req["benchmark"]["config"]
    unknown = set(config) - {"image", "profileDigest", "reference", "implementationDigest", "suite", "python", "simGpus", "simGpuMemGB", "renderer"}
    if unknown:
        raise ValueError("unknown embodied settings: " + ", ".join(sorted(unknown)))
    reference = reference_profile(config)
    if config.get("implementationDigest") != implementation_digest():
        raise ValueError("adapter/SDK content changed; explicitly register the new implementation")
    root = Path(req["benchmark"]["path"])
    for relative, expected in reference["reference"]["files"].items():
        if file_digest(root / relative) != expected:
            raise ValueError("reference input changed: " + relative)
    image = config.get("image", "")
    if not pinned(image):
        raise ValueError("the benchmark image must be an immutable image ID or repository digest")
    renderers = ("xvfb-glx",) if reference.get("environment", {}).get("kind") == "rlbench" else ("osmesa", "egl", "vulkan")
    if config.get("renderer", "osmesa") not in renderers:
        raise ValueError("unsupported native renderer")
    return root, config, reference


def catalog(root, suite):
    source = root / "third_party/libero/libero/libero"
    tree = ast.parse((source / "benchmark/libero_suite_task_map.py").read_text())
    assignment = next(node for node in tree.body if isinstance(node, ast.Assign)
                      and any(isinstance(t, ast.Name) and t.id == "libero_task_map" for t in node.targets))
    names = ast.literal_eval(assignment.value)[suite]
    result = []
    for index, name in enumerate(names):
        asset = source / "init_files" / suite / (name + ".pruned_init")
        result.append({"id": suite + ":" + name, "title": name.replace("_", " "),
                       "supported": True, "reason": None,
                       "tags": {"suite": suite, "taskIndex": str(index),
                                "initialStateDigest": file_digest(asset)}})
    return result


def tasks(req):
    root, config, reference = settings(req)
    suite = config.get("suite", "libero_spatial")
    environment = reference.get("environment", {})
    kind = environment.get("kind")
    calvin = kind == "calvin"
    if kind in GENERATED_ENVIRONMENTS:
        listing = [{"id": task, "title": task.split("/")[-1].replace("_", " "),
                    "supported": True, "reason": None, "tags": {"initialStateDigest": seed_asset(reference, task)}}
                   for task in environment["tasks"]]
        if "simplerScenes" in environment:
            for task in listing:
                task["tags"]["initialStateCount"] = str(initial_state_count(environment, task["id"]))
        if calvin:
            listing[0]["tags"]["initialStateCount"] = str(len(environment["catalog"]["sequences"]))
        if kind == "vlabench":
            for task in listing:
                count = vlabench_state_count(environment, task["id"])
                if count is not None:
                    task["tags"]["initialStateCount"] = str(count)
        if kind in ("robocasa-v02", "rlbench") and "initialStateCount" in environment:
            for task in listing:
                task["tags"]["initialStateCount"] = str(environment["initialStateCount"])
    elif kind == "libero-plus":
        if suite != environment["suite"]:
            raise ValueError("LIBERO-Plus suite differs from the frozen registration")
        listing = libero_plus_catalog(root, suite)
    else:
        if suite not in reference["horizons"]:
            raise ValueError("unsupported LIBERO suite")
        listing = catalog(root, suite)
    source = reference["reference"].get("evaluation", reference["reference"].get("openpi"))
    metrics = []
    if calvin:
        metrics = [{"name": CALVIN_COMPLETED_SUBTASKS, "label": "Completed subtasks", "range": [0, 5],
                    "primary": True}]
        metrics.extend({"name": f"success_at_{n}", "label": f"Completed at least {n}", "unit": "ratio",
                        "range": [0, 1]} for n in range(1, 6))
    if kind == "vlabench":
        metrics = [{"name": name, "label": label, "unit": "ratio", "range": [0, 1]}
                   for name, label in VLABENCH_METRICS.items()]
    elif kind == "libero-plus":
        metrics = [{"name": metric_name(category), "label": category + " success", "unit": "ratio",
                    "range": [0, 1]} for category in PERTURBATIONS]
    return {"tasks": listing,
            **({"metrics": metrics} if metrics else {}),
            "capabilities": {"category": "embodied-policy", "embodied": {
                                 "profile": reference["id"], "semanticProfile": reference["benchmarkProfile"],
                                 "observationMap": reference["observationMap"],
                                 **({"batch": {"maxEpisodes": 128}} if kind != "rlbench" else {}),
                             }, "profiles": ["sim", "sync", "step"],
                             "domains": ["embodied"], "methods": ["policy"],
                             "taxonomy": {"domains": ["robotics"], "taskTypes": ["manipulation"],
                                          "interfaces": ["physical-control"], "platforms": ["simulation"],
                                          "world": ["controlled"], "feedback": ["step"], "participants": [],
                                          "scoringEvidence": ["trajectory"], "scoringMethods": ["rule-check"]},
                             "scoreKind": "scalar" if calvin else "binary", "rescore": "evidence",
                             "calibration": {"oracle": "none", "seedsVary": True},
                             "conditions": {"Protocol": reference["id"], "Profile digest": digest(reference),
                                            "Source": source["commit"],
                                            "Environment": config["image"], "Renderer": config.get("renderer", "osmesa"),
                                            "Randomness": "fresh policy service per solve Run; fixed batches advance its declared stream in frozen order"}},
            "official": {"name": reference.get("scoreName", "OpenPI LIBERO success"), "version": source["commit"],
                         "errors": reference.get("scoreErrors", "fail"), "unit": reference.get("scoreUnit", "sample"),
                         **({"metric": CALVIN_COMPLETED_SUBTASKS} if calvin else {})}}


def stage(req):
    destination = Path(req["trial"]["staging"])
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copytree(SDK / "orbit_embodied", destination / "python/orbit_embodied", dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "test_*.py"))
    shutil.copy2(HERE / "run.py", destination / "run.py")
    shutil.copy2(HERE / "adapter.py", destination / "adapter.py")
    return destination


def solve_one(req):
    _, config, reference = settings(req)
    trial = req["trial"]
    if "seed" in trial or not trial.get("sample") or trial["sampleRef"] != trial["sample"]["sampleId"]:
        raise ValueError("native embodied execution requires a planned sample, not legacy seeds")
    check_sample(trial["sample"], trial["sampleRef"])
    environment = reference.get("environment", {})
    sample = trial["sample"]
    if "simplerScenes" in environment:
        scene_at(environment, sample["taskId"], int(sample["initialStateId"]))
    if environment.get("kind") in ("vlabench", "robocasa-v02", "rlbench"):
        if sample["taskId"] not in environment["tasks"] or sample["initialStateDigest"] != seed_asset(reference, sample["taskId"]):
            raise ValueError("sample differs from the frozen native catalog")
        reset_seed(sample, reference)
    if environment.get("kind") == "libero-plus":
        if sample["taskId"].partition(":")[0] != environment["suite"] or sample["initialStateId"] != "0":
            raise ValueError("LIBERO-Plus requires the selected suite and one initial state per task")
    definition = trial["method"].get("policySnapshot")
    if not definition:
        raise ValueError("missing or incompatible frozen policy definition")
    binding = trial.get("binding")
    expected = resolve_binding(reference["benchmarkProfile"], definition["profile"], reference["observationMap"])
    if binding != expected:
        raise ValueError("resolved binding differs from the submitted snapshot")
    destination = stage(req)
    payload = {"trialId": trial["id"], "sample": trial["sample"],
               "episodeId": trial["id"] + "." + uuid.uuid4().hex,
               "binding": binding, "reference": reference, "policy": definition,
               "timeoutMin": trial.get("timeoutMin", 20),
               "implementationDigest": config["implementationDigest"]}
    (destination / "request.json").write_text(json.dumps(payload, allow_nan=False))
    gl_platform = "egl" if config.get("renderer") == "vulkan" else config.get("renderer", "osmesa")
    memory_gb = 20 if environment.get("kind") == "robocasa-v02" else 8
    resources = {"gpus": int(config.get("simGpus", "0")), "cpus": 4, "memGB": memory_gb}
    if "simGpuMemGB" in config:
        memory = float(config["simGpuMemGB"])
        if resources["gpus"] < 1 or not math.isfinite(memory) or memory <= 0:
            raise ValueError("simGpuMemGB needs a GPU simulator and a finite positive budget")
        resources["gpuMemGB"] = memory
    mounts = [{"source": str(destination), "target": "/orbit-embodied", "mode": "ro"}]
    assets = environment.get("assets")
    if assets:
        mounts.append({"dataset": assets["dataset"], "target": assets["target"], "mode": "ro"})
    return {"spec": {"image": config["image"], "entrypoint": config.get("python", "/.venv/bin/python"),
                     "command": ["/orbit-embodied/run.py", "solve", "/orbit-embodied/request.json", "/orbit/output/episode"],
                     "env": {"PYTHONPATH": "/orbit-embodied/python:/opt/libero-plus:/opt/vlabench:/app/packages/openpi-client/src:/app/third_party/libero:/opt/gr00t:/opt/libero:/opt/simpler:/opt/simpler/ManiSkill2_real2sim:/opt/orbit/rlinf",
                             **({"MUJOCO_GL": gl_platform, "PYOPENGL_PLATFORM": gl_platform}
                                if gl_platform != "xvfb-glx" else {})},
                     "resources": resources,
                     **({"workdir": str(Path(assets["target"]).parent)} if environment.get("kind") == "robotwin" else {}),
                     "timeoutMin": trial.get("timeoutMin", 20), "root": True,
                     "tags": {"embodied_evidence": "4" if environment.get("protocol") == "diffusion-policy" else "2"},
                     "mounts": mounts}}


def solve(req):
    if not req.get("batch"):
        return solve_one(req)
    batch = req["batch"]
    plan, trials = batch["plan"], batch["trials"]
    if digest({key: value for key, value in plan.items() if key != "digest"}) != plan["digest"]:
        raise ValueError("batch plan digest mismatch")
    if not 1 <= len(trials) == len(plan["members"]) <= 128 or trials[0] != req["trial"]:
        raise ValueError("batch membership or leader mismatch")
    reference = reference_profile(req["benchmark"]["config"])
    if reference.get("environment", {}).get("kind") == "rlbench":
        raise ValueError("RLBench requires a fresh simulator process per episode")
    if reference.get("environment", {}).get("kind") in GENERATED_ENVIRONMENTS:
        check_distinct_resets([trial["sample"] for trial in trials], reference)
    payloads, reply = [], None
    for index, (trial, member) in enumerate(zip(trials, plan["members"])):
        if (trial["id"] != member["trialId"] or trial["sampleRef"] != member["sampleRef"]
                or trial.get("batch") != {"plan": plan, "index": index}
                or trial["method"] != trials[0]["method"]
                or trial["binding"] != trials[0]["binding"]):
            raise ValueError("batch trial differs from the frozen membership or method")
        item = solve_one({**req, "trial": trial})
        path = Path(trial["staging"]) / "request.json"
        payload = json.loads(path.read_text())
        payload.update(episodeId=member["episodeId"], batch={"plan": plan, "index": index})
        payloads.append(payload)
        if reply is None:
            reply = item
    destination = Path(trials[0]["staging"])
    (destination / "batch-request.json").write_text(json.dumps({"plan": plan, "episodes": payloads}, allow_nan=False))
    reply["spec"]["command"] = ["/orbit-embodied/run.py", "batch", "/orbit-embodied/batch-request.json", "/orbit/output"]
    reply["spec"]["timeoutMin"] = sum(payload["timeoutMin"] for payload in payloads)
    tags = reply["spec"]["tags"]
    if tags["embodied_evidence"] == "2":
        tags["embodied_evidence"] = "3"
    return reply


def episode_path(req):
    batch = req["trial"].get("batch")
    return "episodes/" + batch["plan"]["members"][batch["index"]]["episodeId"] if batch else "episode"


def verification_expectation(req):
    trial, run = req["trial"], req["solve"]["run"]
    params, tags = run["spec"]["params"], run["spec"]["tags"]
    batch = trial.get("batch")
    fields = (("method", trial["method"]["name"]), ("phase", "solve"))
    if batch:
        plan, index = batch["plan"], batch["index"]
        member = plan["members"][index]
        if (plan["digest"] != digest({key: value for key, value in plan.items() if key != "digest"})
                or member["sampleRef"] != trial["sampleRef"]
                or tags.get("execution_batch") != plan["id"] or tags.get("batch_attempt") != plan["attemptId"]):
            raise ValueError("batch attempt differs from the frozen trial")
        fields += (("batchDigest", plan["digest"]),)
        execution_trial = member["trialId"]
    else:
        fields += (("sampleRef", trial["sampleRef"]), ("task", trial["task"]))
        execution_trial = tags.get("execution_trial") or tags.get("source_trial") or tags.get("trial")
    for key, value in fields:
        if params.get(key) != value:
            raise ValueError("solve Run differs from the frozen trial: " + key)
    check_sample(trial["sample"], trial["sampleRef"])
    config = req["benchmark"]["config"]
    reference = reference_profile(config)
    if not execution_trial or not trial.get("binding") or not trial["method"].get("policySnapshot"):
        raise ValueError("missing frozen verification context")
    version = int(tags.get("embodied_evidence", "1"))
    legacy = version in (1, 2, 3) and bool(batch) == (version == 3)
    native_done = version == 4 and reference.get("environment", {}).get("protocol") == "diffusion-policy"
    if not (legacy or native_done):
        raise ValueError("unsupported embodied evidence version")
    return {"version": 1, "trialId": trial["id"], "sample": trial["sample"],
            "binding": trial["binding"], "policy": trial["method"]["policySnapshot"],
            "reference": reference, "solveImplementationDigest": config["implementationDigest"],
            "solveRunId": run["id"], "executionTrialId": execution_trial,
            "evidenceVersion": version, "verifierDigest": implementation_digest(),
            **({"batch": batch} if batch else {})}


def verify(req):
    config = req["benchmark"]["config"]
    if not pinned(config["image"]):
        raise ValueError("verification image must be pinned")
    expected = verification_expectation(req)
    destination = stage(req)
    (destination / "verify-request.json").write_text(json.dumps(expected, allow_nan=False))
    return {"spec": {"image": config["image"], "entrypoint": config.get("python", "/.venv/bin/python"),
                     "command": ["/orbit-embodied/run.py", "verify", "/solve/" + episode_path(req), "/orbit/output/verified.json",
                                 "/orbit-embodied/verify-request.json"],
                     "env": {"PYTHONPATH": "/orbit-embodied/python"},
                     "resources": {"gpus": 0, "cpus": 1, "memGB": 1}, "timeoutMin": 2,
                     "network": False,
                     "mounts": [{"source": str(destination), "target": "/orbit-embodied", "mode": "ro"},
                                {"source": req["solve"]["output"], "target": "/solve", "mode": "ro"}]}}


def score(req):
    try:
        result = json.loads((Path(req["verify"]["output"]) / "verified.json").read_text())
        verification = json.loads((Path(req["verify"]["output"]) / "verification.json").read_text())
        prefix = episode_path(req)
        native = json.loads((Path(req["solve"]["output"]) / prefix / "native-result.json").read_text())
        if result != native or result["sampleRef"] != req["trial"]["sampleRef"]:
            raise ValueError("verifier and native evidence disagree")
        if verification["sampleRef"] != result["sampleRef"] or verification["episodeId"] != result["episodeId"]:
            raise ValueError("verification identity differs from the episode")
        expected = verification_expectation(req)
        if (verification.get("solveRunId") != expected["solveRunId"]
                or verification.get("trialId") != expected["trialId"]
                or verification.get("implementationDigest") != expected["verifierDigest"]
                or verification.get("expectationDigest") != digest(expected)):
            raise ValueError("verification belongs to another frozen trial or solve Run")
        if not result["valid"]:
            return invalid(result.get("failure", "scorer_error"), *result["issues"])
        files = [
            {"label": "Native episode", "phase": "solve", "path": prefix + "/native-result.json", "kind": "json"},
            {"label": "Resolved binding", "phase": "solve", "path": prefix + "/resolved-binding.json", "kind": "json"},
            {"label": "Verifier identity", "phase": "verify", "path": "verification.json", "kind": "json"},
        ]
        if (Path(req["solve"]["output"]) / "implementation/manifest.json").is_file():
            files.append({"label": "Driver implementation", "phase": "solve", "path": "implementation/manifest.json", "kind": "json"})
        if (Path(req["solve"]["output"]) / prefix / "video.mp4").is_file():
            files.append({"label": "Episode video", "phase": "solve", "path": prefix + "/video.mp4"})
        if (Path(req["verify"]["output"]) / "orbit-trajectory.json").is_file():
            files.append({"label": "Episode timeline", "phase": "verify", "path": "orbit-trajectory.json", "kind": "episode"})
        if req["trial"].get("batch"):
            files.append({"label": "Fixed solve batch", "phase": "solve", "path": "batch-plan.json", "kind": "json"})
        kind = expected["reference"].get("environment", {}).get("kind")
        if kind == "calvin":
            completed = result["native"]["completedSubtasks"]
            metrics = {CALVIN_COMPLETED_SUBTASKS: completed,
                       **{f"success_at_{n}": int(completed >= n) for n in range(1, 6)}}
            return valid(completed, 5, metrics=metrics,
                         issues=result["issues"], review={"files": files})
        success = int(result["success"])
        metrics = None
        if kind == "vlabench":
            metrics = result["native"]["metrics"]
        elif kind == "libero-plus":
            metrics = {metric_name(result["native"]["perturbation"]): success}
        return valid(success, metrics=metrics, issues=result["issues"], review={"files": files})
    except Exception as exc:
        return invalid("scorer_error", str(exc))


if __name__ == "__main__":
    sys.exit(main(tasks, solve, verify, score))
