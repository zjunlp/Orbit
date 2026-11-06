#!/usr/bin/env -S python3 -B
"""Orbit protocol 1 adapter: native environments, independent policy, one planned episode."""

import ast
import hashlib
import json
from pathlib import Path
import shutil
import sys
import uuid

HERE = Path(__file__).resolve().parent
SDK = HERE.parents[1] / "sdk"
sys.path.insert(0, str(SDK))
from orbit_bench import invalid, main, pinned, valid
from orbit_embodied import digest, resolve_binding
from orbit_embodied.binding import check_sample, seed_asset


def file_digest(path):
    return "sha256:" + hashlib.sha256(Path(path).read_bytes()).hexdigest()


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
    unknown = set(config) - {"image", "profileDigest", "reference", "implementationDigest", "suite", "python", "simGpus", "renderer"}
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
    if config.get("renderer", "osmesa") not in ("osmesa", "egl", "vulkan"):
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
    if environment.get("kind") == "registered-gym":
        listing = [{"id": task, "title": task.split("/")[-1].replace("_", " "),
                    "supported": True, "reason": None, "tags": {"initialStateDigest": seed_asset(reference, task)}}
                   for task in environment["tasks"]]
    else:
        if suite not in reference["horizons"]:
            raise ValueError("unsupported LIBERO suite")
        listing = catalog(root, suite)
    source = reference["reference"].get("evaluation", reference["reference"].get("openpi"))
    return {"tasks": listing,
            "capabilities": {"category": "embodied-policy", "embodied": {"profile": reference["id"], "semanticProfile": reference["benchmarkProfile"], "observationMap": reference["observationMap"]}, "profiles": ["sim", "sync", "step"],
                             "domains": ["embodied"], "methods": ["policy"],
                             "scoreKind": "binary", "rescore": "evidence",
                             "calibration": {"oracle": "none", "seedsVary": True},
                             "conditions": {"Protocol": reference["id"], "Profile digest": digest(reference),
                                            "Source": source["commit"],
                                            "Environment": config["image"], "Renderer": config.get("renderer", "osmesa"),
                                            "Randomness": "fresh policy service per trial; reference stream parity unverified"}},
            "official": {"name": reference.get("scoreName", "OpenPI LIBERO success"), "version": source["commit"],
                         "errors": "fail", "unit": "sample"}}


def stage(req):
    destination = Path(req["trial"]["staging"])
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copytree(SDK / "orbit_embodied", destination / "python/orbit_embodied", dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "test_*.py"))
    shutil.copy2(HERE / "run.py", destination / "run.py")
    shutil.copy2(HERE / "adapter.py", destination / "adapter.py")
    return destination


def solve(req):
    _, config, reference = settings(req)
    trial = req["trial"]
    if "seed" in trial or not trial.get("sample") or trial["sampleRef"] != trial["sample"]["sampleId"]:
        raise ValueError("native embodied execution requires a planned sample, not legacy seeds")
    check_sample(trial["sample"], trial["sampleRef"])
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
               "implementationDigest": config["implementationDigest"]}
    (destination / "request.json").write_text(json.dumps(payload, allow_nan=False))
    gl_platform = "egl" if config.get("renderer") == "vulkan" else config.get("renderer", "osmesa")
    return {"spec": {"image": config["image"], "entrypoint": config.get("python", "/.venv/bin/python"),
                     "command": ["/orbit-embodied/run.py", "solve", "/orbit-embodied/request.json", "/orbit/output/episode"],
                     "env": {"PYTHONPATH": "/orbit-embodied/python:/app/packages/openpi-client/src:/app/third_party/libero:/opt/gr00t:/opt/libero:/opt/simpler:/opt/simpler/ManiSkill2_real2sim",
                             "MUJOCO_GL": gl_platform,
                             "PYOPENGL_PLATFORM": gl_platform},
                     "resources": {"gpus": int(config.get("simGpus", "0")), "cpus": 4, "memGB": 8},
                     "timeoutMin": trial.get("timeoutMin", 20), "root": True,
                     "tags": {"embodied_evidence": "2"},
                     "mounts": [{"source": str(destination), "target": "/orbit-embodied", "mode": "ro"}]}}


def verification_expectation(req):
    trial, run = req["trial"], req["solve"]["run"]
    params, tags = run["spec"]["params"], run["spec"]["tags"]
    for key, value in (("sampleRef", trial["sampleRef"]), ("task", trial["task"]),
                       ("method", trial["method"]["name"]), ("phase", "solve")):
        if params.get(key) != value:
            raise ValueError("solve Run differs from the frozen trial: " + key)
    check_sample(trial["sample"], trial["sampleRef"])
    config = req["benchmark"]["config"]
    reference = reference_profile(config)
    execution_trial = tags.get("execution_trial") or tags.get("source_trial") or tags.get("trial")
    if not execution_trial or not trial.get("binding") or not trial["method"].get("policySnapshot"):
        raise ValueError("missing frozen verification context")
    version = int(tags.get("embodied_evidence", "1"))
    if version not in (1, 2):
        raise ValueError("unsupported embodied evidence version")
    return {"version": 1, "trialId": trial["id"], "sample": trial["sample"],
            "binding": trial["binding"], "policy": trial["method"]["policySnapshot"],
            "reference": reference, "solveImplementationDigest": config["implementationDigest"],
            "solveRunId": run["id"], "executionTrialId": execution_trial,
            "evidenceVersion": version, "verifierDigest": implementation_digest()}


def verify(req):
    config = req["benchmark"]["config"]
    if not pinned(config["image"]):
        raise ValueError("verification image must be pinned")
    expected = verification_expectation(req)
    destination = stage(req)
    (destination / "verify-request.json").write_text(json.dumps(expected, allow_nan=False))
    return {"spec": {"image": config["image"], "entrypoint": config.get("python", "/.venv/bin/python"),
                     "command": ["/orbit-embodied/run.py", "verify", "/solve/episode", "/orbit/output/verified.json",
                                 "/orbit-embodied/verify-request.json"],
                     "env": {"PYTHONPATH": "/orbit-embodied/python"},
                     "resources": {"gpus": 0, "cpus": 1, "memGB": 1}, "timeoutMin": 2,
                     "root": True, "network": False,
                     "mounts": [{"source": str(destination), "target": "/orbit-embodied", "mode": "ro"},
                                {"source": req["solve"]["output"], "target": "/solve", "mode": "ro"}]}}


def score(req):
    try:
        result = json.loads((Path(req["verify"]["output"]) / "verified.json").read_text())
        verification = json.loads((Path(req["verify"]["output"]) / "verification.json").read_text())
        native = json.loads((Path(req["solve"]["output"]) / "episode/native-result.json").read_text())
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
            {"label": "Native episode", "phase": "solve", "path": "episode/native-result.json", "kind": "json"},
            {"label": "Resolved binding", "phase": "solve", "path": "episode/resolved-binding.json", "kind": "json"},
            {"label": "Verifier identity", "phase": "verify", "path": "verification.json", "kind": "json"},
        ]
        if (Path(req["solve"]["output"]) / "implementation/manifest.json").is_file():
            files.append({"label": "Driver implementation", "phase": "solve", "path": "implementation/manifest.json", "kind": "json"})
        if (Path(req["solve"]["output"]) / "episode/video.mp4").is_file():
            files.append({"label": "Episode video", "phase": "solve", "path": "episode/video.mp4"})
        return valid(int(result["success"]), issues=result["issues"], review={"files": files})
    except Exception as exc:
        return invalid("scorer_error", str(exc))


if __name__ == "__main__":
    sys.exit(main(tasks, solve, verify, score))
