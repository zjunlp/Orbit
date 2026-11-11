#!/usr/bin/env -S python3 -B
"""EmbodiedCLBench native visual household tools and continual-learning sequences."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import main, invalid, valid

HERE = Path(__file__).resolve().parent
REVISION = "f33105f017f5408f8d2c6debe8bd4086881d3ea4"
IMAGE = "orbit-embodied-clbench:f33105f-1"
CONFIG = {"data", "subset", "image"}
SETTINGS = ("basic_l2", "zero_shot_l4", "in_context_l4", "skill_l4")
SKILL_REASON = "Skill learning requires a fresh Agent context after distillation; this adapter currently preserves full context only (ICL)."


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def settings(req):
    b = req["benchmark"]
    c = b.get("config", {})
    if set(c) - CONFIG:
        raise ValueError(f"Unknown config keys: {sorted(set(c) - CONFIG)}")
    root = Path(b["path"]).resolve()
    revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if revision != REVISION:
        raise ValueError(f"Expected official source revision {REVISION}, found {revision}")
    if subprocess.run(["git", "-C", str(root), "diff", "--quiet", "HEAD", "--", "public/eval", "For_user/templates", "For_user/scripts/summarize_l2_l4_results.py"]).returncode:
        raise ValueError("Native runtime, templates or grader differ from the pinned source")
    data = Path(c.get("data", root / "For_user/data")).expanduser().resolve()
    subset = c.get("subset", "stage0_smoke")
    if subset not in ("stage0_smoke", "stage2_20pct", "stage3_full"):
        raise ValueError("subset must be stage0_smoke, stage2_20pct or stage3_full; no silent fallback")
    return root, data, subset


def catalog(req):
    root, data, subset = settings(req)
    source = data / "subsets" / subset
    basic = read(source / "ready_l2_tasks_with_images.json")
    advanced = read(source / "ready_l4_tasks_with_images.json")
    learning = read(source / "learning_plan.json")["targets"]
    mappings = {}
    for row in learning:
        task = row.get("target_task_id") or row.get("task_id")
        ids = row.get("learning_task_ids") or row.get("icl_learning_task_ids") or []
        if task in mappings or not isinstance(ids, list) or not ids:
            raise ValueError("Learning plan contains duplicate targets or empty sequences")
        mappings[task] = ids
    entries = {}
    for level, rows in (("L2", basic), ("L4", advanced)):
        if not isinstance(rows, list) or not rows:
            raise ValueError(f"Missing nonempty {level} task catalog")
        seen = set()
        for row in rows:
            task = row["task_id"]
            if not re.fullmatch(r"[A-Za-z0-9_-]+", task) or task in seen:
                raise ValueError("Task ids must be unique safe path components")
            seen.add(task)
            for mode in (SETTINGS[:1] if level == "L2" else SETTINGS[1:]):
                ids = [*(mappings.get(task, []) if mode in SETTINGS[2:] else []), task]
                problems = []
                if mode == "skill_l4":
                    problems.append(SKILL_REASON)
                if mode in SETTINGS[2:] and task not in mappings:
                    problems.append("Official learning plan has no sequence for this target")
                for tid in ids:
                    if not isinstance(tid, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", tid):
                        raise ValueError("Invalid learning task id")
                    taskroot = data / "input/merged/tasks" / tid
                    if not (taskroot / "input" / f"{tid}_atomic_expanded_graph.json").is_file():
                        problems.append(f"Missing official graph for {tid}")
                    if not (taskroot / "task_image_manifest.json").is_file():
                        problems.append(f"Missing official image manifest for {tid}")
                if not (data / "input/merged/option_bank_highlevel_v2_smoke.jsonl").is_file():
                    problems.append("Missing official safe-choice option bank")
                entries[f"{mode}/{task}"] = {"mode": mode, "target": task, "ids": ids,
                    "problems": problems, "level": level, "scene": str(row.get("scene_id", ""))}
    return root, data, subset, entries


def tasks(req):
    _, _, subset, entries = catalog(req)
    return {"tasks": [{"id": key, "title": f"{row['mode']}: {row['target']}",
        "supported": not row["problems"], "reason": "; ".join(row["problems"]) or None,
        "tags": {"suite": row["mode"], "subset": subset, "level": row["level"],
                 "episodes": str(len(row["ids"])), "scene": row["scene"]},
        "taxonomy": {"targets": ["planning", "tool-use", "perception-grounding",
            *(["memory", "learning-adaptation", "generalization"] if row["mode"] in SETTINGS[2:] else [])]}}
        for key, row in entries.items()], "capabilities": {
        "identity": {"id": "embodied-clbench", "name": "EmbodiedCLBench", "version": REVISION},
        "methods": ["codex", "claude-code", "empty", "oracle"], "requires": ["mcp"],
        "scoreKind": "binary", "rescore": "evidence",
        "taxonomy": {"domains": ["robotics"], "taskTypes": ["navigation", "manipulation"],
            "targets": ["planning", "tool-use", "perception-grounding"],
            "modalities": ["text", "image"], "interfaces": ["tool-api"], "platforms": ["simulation"],
            "world": ["controlled"], "feedback": ["step"], "scoringEvidence": ["trajectory", "final-state"],
            "scoringMethods": ["rule-check"]},
        "conditions": {"Evaluated subject": "Model + Agent CLI harness + full-context continual experience",
            "Sequence": "One trial = official ordered learning tasks then target; context isolated between trials",
            "Observation": "Native safe-choice MCP image blocks and text; images are never silently omitted",
            "Budget": "Native shortest path + 6 rollout actions; official report SR at shortest path + 3",
            "Skill learning": SKILL_REASON,
            "Native image coverage": "The release marks some unrendered branches; reaching a nonterminal observation without an image is invalid, not a text-only fallback",
            "Scoring": "Native graph runtime replay, grade_trace and official budget_rows; only target contributes"}},
        "metrics": [{"name": "score", "label": "Target success (+3 actions)", "unit": "%", "primary": True,
            "description": "Original EmbodiedCLBench report success at shortest path plus three actions"}]}


def image_files(root, merged, task_ids):
    code = """
import json, sys
from pathlib import Path
from tongbench_eval.cli.framework.dialogue import _manifest_image_dir, _image_files_in_dir
root = Path(sys.argv[1])
files = set()
for task in json.loads(sys.argv[2]):
    manifest = json.loads((root / 'tasks' / task / 'task_image_manifest.json').read_text())
    states = manifest.get('states', [])
    if not states:
        raise ValueError('No official visual states for ' + task)
    for state in states:
        directory = _manifest_image_dir(state, root)
        images = _image_files_in_dir(directory) if directory else []
        if not images:
            if state.get('match_status') == 'missing_image_in_packaging':
                continue
            raise ValueError('Missing packaged visual state for ' + task)
        for path in images:
            files.add(str(path.resolve().relative_to(root.resolve())))
print(json.dumps(sorted(files)))
"""
    result = subprocess.run([sys.executable, '-B', '-c', code, str(merged), json.dumps(task_ids)],
        env={**os.environ, 'PYTHONPATH': str(root / 'public/eval/src')},
        capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise ValueError(result.stderr.strip())
    return json.loads(result.stdout)


def plan_for(req):
    root, data, subset, entries = catalog(req)
    trial = req["trial"]
    row = entries.get(trial["task"])
    if row is None or row["problems"]:
        raise ValueError("Unknown or unsupported task: " + ("; ".join(row["problems"]) if row else trial["task"]))
    if trial.get("options"):
        raise ValueError("No trial options; choose setting in task id and subset at registration")
    if trial.get("hostNetwork"):
        raise ValueError("Private environment service requires hostNetwork=false")
    method = trial["method"]["agent"]
    if method not in ("codex", "claude-code", "empty", "oracle"):
        raise ValueError(f"Unsupported Agent: {method}")
    fingerprints = {}
    merged = data / "input/merged"
    for tid in row["ids"]:
        for path in sorted((merged / "tasks" / tid).rglob("*.json")):
            fingerprints[str(path.relative_to(merged))] = digest(path)
    for relative in image_files(root, merged, row["ids"]):
        fingerprints[relative] = digest(merged / relative)
    fingerprints["option_bank_highlevel_v2_smoke.jsonl"] = digest(merged / "option_bank_highlevel_v2_smoke.jsonl")
    plan = {"task": trial["task"], "target": row["target"], "task_ids": row["ids"],
            "mode": row["mode"], "subset": subset, "seed": trial["seed"], "method": method,
            "source_revision": REVISION, "fingerprints": fingerprints, "rollout_extra": 6, "report_extra": 3}
    return root, data, plan


def stage(req, plan):
    staging = Path(req["trial"]["staging"])
    staging.mkdir(parents=True, exist_ok=True)
    for name in ("runtime.py", "proxy.py"):
        shutil.copyfile(HERE / name, staging / name)
    write(staging / "plan.json", plan)
    return staging


def binds(root, data, staging):
    return [{"source": str(root), "target": "/upstream", "mode": "ro"},
            {"source": str(data / "input/merged"), "target": "/data", "mode": "ro"},
            {"source": str(staging), "target": "/adapter", "mode": "ro"}]


def solve(req):
    root, data, plan = plan_for(req)
    staging = stage(req, plan)
    image = req["benchmark"].get("config", {}).get("image", IMAGE)
    resources = {"cpus": 2, "memGB": 4, "gpus": 0, **(req["trial"].get("resources") or {})}
    resources.pop("timeoutMin", None)
    if resources["gpus"] != 0:
        raise ValueError("This pre-rendered graph benchmark runs on CPU; it is not a GPU policy benchmark")
    env = {"PYTHONPATH": "/upstream/public/eval/src", "PYTHONDONTWRITEBYTECODE": "1"}
    spec = {"image": image, "resources": resources,
            "timeoutMin": req["trial"].get("timeoutMin") or 60}
    if plan["method"] in ("empty", "oracle"):
        spec.update({"mounts": binds(root, data, staging), "env": env, "network": False,
                     "command": ["python", "/adapter/runtime.py", plan["method"], "/adapter/plan.json"]})
    else:
        spec.update({"mounts": [{"source": str(staging / "proxy.py"), "target": "/tools/clbench-mcp.py", "mode": "ro"}],
            "agentTask": {"instruction": native_prompt(root), "tools": [{"name": "household-task",
                "command": ["python", "/tools/clbench-mcp.py"]}]}, "network": True,
            "networks": [{"name": "embodied", "internal": True}], "runNetworks": ["default", "embodied"],
            "dependsOn": ["environment"], "env": {"PYTHONDONTWRITEBYTECODE": "1"},
            "services": [{"name": "environment", "image": image,
                "command": ["python", "/adapter/runtime.py", "serve", "/adapter/plan.json"],
                "binds": binds(root, data, staging), "env": env, "cpus": 2, "memGB": 4,
                "init": True, "networks": ["embodied"], "collect": ["/evidence"],
                "healthcheck": {"command": ["python", "-c", "import socket; socket.create_connection(('127.0.0.1',8765),2).close()"],
                    "intervalSec": 2, "timeoutSec": 3, "startPeriodSec": 30, "retries": 30}}],
            "hooks": [{"service": "environment", "command": "python /adapter/runtime.py finalize /adapter/plan.json", "timeoutSec": 90}]})
    return {"spec": spec, "issues": []}


def native_prompt(root):
    # This helper reads only the native prompt; no environment or Agent is started here.
    code = "from tongbench_eval.cli.framework.dialogue import _build_sequence_prompt; print(_build_sequence_prompt([], protocol_surface='safe_choice'))"
    result = subprocess.run([sys.executable, "-B", "-c", code], env={**os.environ,
        "PYTHONPATH": str(root / "public/eval/src")}, capture_output=True, text=True, timeout=30, check=True)
    return result.stdout.strip()


def verify(req):
    root, data, plan = plan_for(req)
    staging = stage(req, plan)
    output = Path(req["solve"]["output"])
    evidence = output / ("evidence" if plan["method"] in ("empty", "oracle") else "services/environment/evidence")
    return {"spec": {"image": req["benchmark"].get("config", {}).get("image", IMAGE),
        "mounts": [*binds(root, data, staging), {"source": str(evidence), "target": "/solve", "mode": "ro"}],
        "resources": {"cpus": 2, "memGB": 4, "gpus": 0}, "timeoutMin": 15, "network": False,
        "env": {"PYTHONPATH": "/upstream/public/eval/src", "PYTHONDONTWRITEBYTECODE": "1"},
        "command": ["python", "/adapter/runtime.py", "verify", "/adapter/plan.json"]}}


def score(req):
    review = {"files": [{"label": "Native sequence verification", "phase": "verify", "kind": "json", "path": "result.json"}],
              "details": {"protocol": "Native visual safe-choice", "memory": "Full context within one trial; fresh Agent per trial"}}
    try:
        result = read(Path(req["verify"]["output"]) / "result.json")
        if result.get("error"):
            return invalid("scorer_error", result["error"], review=review)
        if result["task"] != req["trial"]["task"] or result["source_revision"] != REVISION:
            raise ValueError("Verifier task/revision mismatch")
        value = result["score"]
        if type(value) not in (int, float) or value not in (0, 1):
            raise ValueError("Native score must be binary")
        review["items"] = [{"criterion": row["task_id"], "score": result["score"] if row["task_id"] == result["target"] else row["score"]["SR"], "maxScore": 1,
            "weight": 1 if row["task_id"] == result["target"] else 0,
            "reasoning": "Target (+3 budget)" if row["task_id"] == result["target"] else "Learning episode; excluded from target score"}
            for row in result["episodes"]]
        return valid(value, review=review)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        return invalid("scorer_error", str(exc), review=review)


if __name__ == "__main__":
    raise SystemExit(main(tasks, solve, verify, score))
