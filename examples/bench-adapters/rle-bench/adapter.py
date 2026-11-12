#!/usr/bin/env python3
"""RLE-Bench metadata and failure semantics on Orbit's existing Harbor adapter."""

import copy
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import invalid, main, pinned

REVISION = "c6bf572283b5453c0ee76eaa3054f23d691e433d"
COUNTS = dict(zip((f"task{i:02}" for i in range(1, 10)), (15, 15, 5, 5, 4, 4, 1, 1, 1)))
UNSUPPORTED = {
    "task09": "Native trim.py runs with the verifier UID and can modify verifier code and reward files; trusted submission isolation is unavailable",
}
TAXONOMY = {
    "domains": ["robotics"],
    "taskTypes": ["implementation", "experimentation", "optimization"],
    "targets": ["planning", "tool-use", "control", "robustness"],
    "modalities": ["text", "image", "structured-data"],
    "interfaces": ["file-edit", "terminal"],
    "platforms": ["simulation"],
    "world": ["controlled"],
    "feedback": ["step"],
    "scoringEvidence": ["artifact", "trajectory"],
    "scoringMethods": ["execution-test", "rule-check"],
}
NETWORK_NOTE = (
    "Orbit gives CLI Agents public network access for model authentication; "
    "the native RLE runner allows only configured provider/setup hosts. "
    "This run does not claim native closed-book network parity."
)


def checked_root(req):
    root = Path(req["benchmark"]["path"]).resolve()
    revision = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"],
        capture_output=True, text=True, check=True, timeout=10,
    ).stdout.strip()
    if revision != REVISION:
        raise ValueError(f"RLE-Bench requires upstream revision {REVISION}; got {revision}")
    if subprocess.run(["git", "-C", str(root), "diff", "--quiet", "HEAD", "--"],
                      timeout=10).returncode:
        raise ValueError("RLE-Bench tracked source differs from the pinned revision")
    return root


def catalog(root):
    paths = sorted((root / "tasks").rglob("task.toml"))
    paths = [p for p in paths if re.fullmatch(r"task0[1-9]", p.relative_to(root / "tasks").parts[0])]
    actual = Counter(p.relative_to(root / "tasks").parts[0] for p in paths)
    if actual != COUNTS:
        raise ValueError("RLE-Bench catalog is incomplete; run prepare.py CHECKOUT --catalog "
                         f"with Python 3.11+ (expected {COUNTS}, found {dict(actual)})")
    counts = Counter(p.parent.name for p in paths)
    return {
        p.parent.relative_to(root / "tasks").as_posix():
        p.parent.relative_to(root / "tasks").as_posix() if counts[p.parent.name] > 1 else p.parent.name
        for p in paths
    }


def prepared_digest(root, family=None):
    digest = hashlib.sha256()
    for task in sorted((root / "tasks").rglob("task.toml")):
        relative = task.relative_to(root / "tasks")
        if not re.fullmatch(r"task0[1-9]", relative.parts[0]):
            continue
        if family is not None and relative.parts[0] != family:
            continue
        for path in sorted(task.parent.rglob("*")):
            if "__pycache__" in path.parts or path.suffix == ".pyc":
                continue
            if path.is_symlink():
                raise ValueError(f"prepared task contains a symlink: {path}")
            if path.is_file():
                digest.update(path.relative_to(root).as_posix().encode() + b"\0")
                with path.open("rb") as source:
                    while chunk := source.read(1024 * 1024):
                        digest.update(chunk)
                digest.update(b"\0")
    return digest.hexdigest()


def check_prepared(root):
    path = root / "orbit-catalog.json"
    if not path.is_file():
        raise ValueError("missing preparation digest; run prepare.py CHECKOUT --catalog")
    lock = json.loads(path.read_text())
    if lock.get("revision") != REVISION or lock.get("digest") != prepared_digest(root):
        raise ValueError("prepared RLE task files changed; regenerate and rebuild with prepare.py")


def delegate(req):
    forwarded = copy.deepcopy(req)
    cfg = forwarded["benchmark"].get("config", {})
    unknown = set(cfg) - {"orbit", "imageMap"}
    if unknown:
        raise ValueError(f"unknown RLE-Bench configuration: {sorted(unknown)}")
    executable = cfg.get("orbit") or shutil.which("orbit")
    if not executable:
        raise ValueError("orbit is not on PATH; register with -c orbit=/absolute/path/to/orbit")
    forwarded["benchmark"]["config"] = {}
    if req["op"] != "score":
        root = checked_root(req)
        mapping = catalog(root)
        check_prepared(root)
        if "trial" in forwarded and forwarded["trial"]:
            task = forwarded["trial"]["task"]
            if task not in mapping:
                raise ValueError(f"unknown RLE-Bench task: {task}")
            forwarded["trial"]["task"] = mapping[task]
    result = subprocess.run(
        [executable, "__adapter", "harbor", req["op"]],
        input=json.dumps(forwarded), capture_output=True, text=True, timeout=100,
    )
    if result.returncode:
        raise ValueError(f"Orbit Harbor planning failed: {result.stderr.strip()[:2000]}")
    return json.loads(result.stdout)


def tasks(req):
    reply = delegate(req)
    reverse = {v: k for k, v in catalog(Path(req["benchmark"]["path"])).items()}
    for task in reply["tasks"]:
        task["id"] = reverse[task["id"]]
        if task["id"] in UNSUPPORTED:
            task["supported"] = False
            task["reason"] = UNSUPPORTED[task["id"]]
        task["tags"].update({"domain": "embodied", "suite": task["id"].split("/")[0],
                             "profile": "embodied-program", "evaluation": "coding-agent-harness"})
        task["taxonomy"] = TAXONOMY
        if task["id"] != "task08":
            task["tags"]["oracle"] = "partial"
    reply["metrics"] = [{"name": "score", "label": "Native reward",
                          "description": "Official verifier reward; 1 is the maximum"}]
    reply["capabilities"] = {
        "identity": {"id": "rle-bench", "name": "RLE-Bench"},
        "taxonomy": TAXONOMY,
        "methods": ["cli", "empty", "oracle"], "scoreKind": "scalar", "rescore": "evidence",
        "calibration": {"oracle": {"min": 0.64, "max": 1}},
        "conditions": {
            "Upstream": REVISION,
            "Target": "Coding Agent and harness developing robotics artifacts",
            "Catalog": "All 51 native tasks remain visible; unsupported Harbor settings and unsafe native graders fail closed",
            "Scoring": "Original isolated verifier and complete task budgets",
            "Oracle calibration": "task08 >= 0.64 from upstream test_base_design_golden.py; other tasks skip automatic oracle calibration",
            "Network": NETWORK_NOTE,
        },
    }
    return reply


def pin_images(req, spec):
    cfg = req["benchmark"].get("config", {})
    path = Path(cfg.get("imageMap") or Path(req["benchmark"]["path"]) / "orbit-images.json")
    lock = json.loads(path.read_text())
    if lock.get("revision") != REVISION:
        raise ValueError("image map must belong to the pinned RLE-Bench revision")
    images = lock["images"]
    family_digests = {}

    def visit(value):
        if isinstance(value, dict):
            if "image" in value:
                original = value["image"]
                match = re.match(r"rlebench-(task0[1-9])-", original)
                if match:
                    family = match[1]
                    expected = lock.get("inputs", {}).get(original)
                    if not expected:
                        raise ValueError(f"image map lacks build input digest for {original}")
                    if family not in family_digests:
                        family_digests[family] = prepared_digest(Path(req["benchmark"]["path"]), family)
                    if expected != family_digests[family]:
                        raise ValueError(f"image build inputs changed for {original}; rebuild it")
                resolved = images.get(original, original)
                if not pinned(resolved):
                    raise ValueError(f"missing immutable image for {original}; run prepare.py --build")
                value["image"] = resolved
            if "dockerfile" in value:
                raise ValueError("RLE-Bench must use prepared, pinned images")
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(spec)


def solve(req):
    if req["trial"]["task"] in UNSUPPORTED:
        raise ValueError(UNSUPPORTED[req["trial"]["task"]])
    reply = delegate(req)
    pin_images(req, reply["spec"])
    reply["spec"].setdefault("env", {})["PYTHONDONTWRITEBYTECODE"] = "1"
    if req["trial"]["method"]["agent"] not in ("empty", "oracle"):
        reply.setdefault("issues", []).append(NETWORK_NOTE)
    return reply


def verify(req):
    if req["trial"]["task"] in UNSUPPORTED:
        raise ValueError(UNSUPPORTED[req["trial"]["task"]])
    reply = delegate(req)
    pin_images(req, reply["spec"])
    reply["spec"].setdefault("env", {})["PYTHONDONTWRITEBYTECODE"] = "1"
    return reply


def rejected_task08_submission(req, reward, verifier_dir):
    if req.get("trial", {}).get("task") != "task08":
        return None
    if (set(reward) != {"reward", "scoring_error"}
            or type(reward["reward"]) not in (int, float) or reward["reward"] != 0
            or type(reward["scoring_error"]) not in (int, float) or reward["scoring_error"] != 1):
        return None
    try:
        log = (verifier_dir / "test-stdout.txt").read_text(errors="replace")[-65536:]
    except OSError:
        return None
    if not re.search(r'File "/tests/score_task.py", line \d+, in _stage_submission', log):
        return None
    artifacts = Path(req["solve"]["output"]) / "collected/logs/artifacts"
    for name, limit in (("robot.xml", 4194304), ("controller.py", 1048576)):
        try:
            info = (artifacts / name).lstat()
        except OSError:
            continue
        invalid_file = f"ValueError: invalid submitted file: {name}" in log
        exceeded = f"ValueError: submitted file exceeds size limit: {name}" in log
        if stat.S_ISREG(info.st_mode) and info.st_size > limit and (invalid_file or exceeded):
            return f"Native staging rejected {name}: saved submission exceeds {limit} bytes"
        if not stat.S_ISREG(info.st_mode) and invalid_file:
            return f"Native staging rejected {name}: saved submission is not a regular file"
        if stat.S_ISLNK(info.st_mode) and re.search(
            rf"OSError: \[Errno 40\] Too many levels of symbolic links: ['\"]/logs/artifacts/{re.escape(name)}['\"]", log
        ):
            return f"Native staging rejected {name}: saved submission is a symbolic link"
        if stat.S_ISDIR(info.st_mode) and "os.fdopen(" in log and re.search(
            r"IsADirectoryError: \[Errno 21\] Is a directory: \d+", log
        ):
            return f"Native staging rejected {name}: saved submission is a directory"
    return None


def report_items(path):
    """The stages and checkpoints of the native report as rubric rows; nothing when a task has none."""
    try:
        report = json.loads(path.read_text())
    except (OSError, ValueError):
        return []
    if not isinstance(report, dict):
        return []
    failed = report.get("gate_failed") if isinstance(report.get("gate_failed"), list) else []
    items = []
    for kind, key in (("stage", "stages"), ("checkpoint", "checkpoints")):
        rows = report.get(key)
        for name, value in rows.items() if isinstance(rows, dict) else []:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                continue
            item = {"criterion": str(name), "type": kind, "score": value, "maxScore": 1}
            if name in failed:
                item["reasoning"] = "Gate failed: the native scorer caps the reward when this check fails."
            items.append(item)
    return items[:500]


def score(req):
    if req.get("trial", {}).get("task") in UNSUPPORTED:
        return invalid("scorer_error", UNSUPPORTED[req["trial"]["task"]])
    reply = delegate(req)
    sub = "after" if req["verify"]["run"]["spec"].get("after") else "collected"
    reward_file = Path(req["verify"]["output"]) / sub / "logs/verifier/reward.json"
    try:
        reward = json.loads(reward_file.read_text())
    except (OSError, ValueError):
        return invalid("scorer_error", "Native RLE-Bench verifier wrote no readable reward.json",
                       review=reply.get("review"))
    if not isinstance(reward, dict):
        return invalid("scorer_error", "Native RLE-Bench reward is not an object")
    rejection = rejected_task08_submission(req, reward, reward_file.parent)
    if rejection:
        return {"score": 0, "maxScore": 1, "invalid": False, "issues": [rejection],
                "review": reply.get("review", {"files": [], "items": [], "details": {}})}
    for marker in ("scoring_error", "harness_crash", "infra_error", "grader_error"):
        value = reward.get(marker, 0)
        if value != 0:
            return invalid("scorer_error", f"Native RLE-Bench verifier reported {marker}={value}",
                           review=reply.get("review"))
    value = reward.get("reward")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
        return invalid("scorer_error", "Native RLE-Bench reward must be finite and between 0 and 1")
    reply.pop("metrics", None)
    review = reply.setdefault("review", {"files": [], "items": [], "details": {}})
    review.setdefault("details", {}).update({"upstream revision": REVISION,
                                             "evaluation target": "coding-agent harness"})
    for file in review.get("files", []):
        file.setdefault("kind", "json" if file["path"].endswith(".json") else "text")
    review["items"] = report_items(reward_file.parent / "report.json")
    media = reward_file.parent / "media"
    for path in sorted(media.rglob("*")) if media.is_dir() else []:
        if path.is_file() and not path.is_symlink() and path.suffix.lower() in (".png", ".jpg", ".jpeg"):
            review["files"].append({"label": path.name, "phase": "verify", "kind": "image",
                                     "path": path.relative_to(req["verify"]["output"]).as_posix()})
            if sum(file.get("kind") == "image" for file in review["files"]) >= 6:
                break
    return reply


if __name__ == "__main__":
    sys.exit(main(tasks, solve, verify, score))
