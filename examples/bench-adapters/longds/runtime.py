#!/usr/bin/env python3
"""Run unmodified LongDS tools; keep task definitions and judging outside the Agent container."""

import concurrent.futures
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from adapter import IDENTITY, RUNNERS, read, validate_turns, write


def native_command(plan, output):
    agent = plan["method"]["agent"]
    method = plan["method"]
    task_root = output / "inputs" / f"longds_{plan['version']}"
    args = [sys.executable, str(Path(plan["root"]) / "runners" / RUNNERS[agent]),
            "--longds_version", plan["version"], "--split", plan["split"],
            "--task-root", str(task_root), "--data-root", plan["data_root"],
            "--start-index", str(plan["index"]), "--task-limit", "1", "--run-parallel", "1",
            "--run-name", "orbit", "--output-dir", str(output / "native"),
            "--timeout", str(plan["turnTimeoutSec"]), "--analysis-python", plan["analysisPython"],
            "--use-docker", "--docker-image", plan["image"],
            "--docker-network", "host" if plan["hostNetwork"] else "bridge",
            "--docker-cpus", str(plan["resources"]["cpus"]),
            "--docker-memory", str(math_bytes(plan["resources"]["memGB"]))]
    if agent == "codex":
        args += ["--codex-config", str(output / "inputs" / "config.toml")]
        if method.get("model"):
            args += ["--codex-model", method["model"]]
        if method.get("effort"):
            args += ["--reasoning-effort", method["effort"]]
    else:
        args += ["--claude-settings", str(output / "inputs" / "settings.json")]
        if method.get("model"):
            args += ["--claude-model", method["model"]]
        if method.get("effort"):
            args += ["--docker-env", f"CLAUDE_CODE_EFFORT_LEVEL={method['effort']}"]
    return args


def math_bytes(gib):
    return max(1, int(float(gib) * 1024 ** 3))


def checked_results(plan, rows):
    ids = validate_turns(plan["turns"])
    if not isinstance(rows, list) or len(rows) != len(ids):
        raise ValueError("Native runner did not finish every task turn; partial scores are invalid")
    for tid, source, row in zip(ids, plan["turns"], rows):
        if type(row.get("turn_id")) is not int or row["turn_id"] != tid:
            raise ValueError("Native results have missing, reordered or duplicate turn IDs")
        if row.get("question") != source["question"] or row.get("context", "") != source.get("context", ""):
            raise ValueError(f"Native question/context differs on turn {tid}")
        if row.get("success") is not True:
            raise ValueError(f"Native Agent execution failed on turn {tid}")
        if not isinstance(row.get("solution"), str):
            raise ValueError(f"Native result has no text solution on turn {tid}")
    return rows


def solve(plan_path, output):
    plan = read(plan_path)
    validate_turns(plan["turns"])
    task_root = output / "inputs" / f"longds_{plan['version']}"
    write(task_root / f"task_list_{plan['split']}.json", plan["tasks"])
    write(task_root / plan["task"] / "task.json", plan["turns"])
    (output / "inputs" / "config.toml").write_text("", encoding="utf-8")
    write(output / "inputs" / "settings.json", {})
    fingerprints = {}
    for name in ("judge.py", "judge_prompt.py", "longds_dataset.py", "__init__.py"):
        source = Path(plan["root"]) / "runners" / "src" / name
        target = output / "upstream" / "src" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        fingerprints[name] = hashlib.sha256(target.read_bytes()).hexdigest()
    plan["judgeSources"] = fingerprints
    plan["nativePath"] = f"native/longds_{plan['version']}_{plan['split']}/orbit/{plan['task']}"
    write(output / "selection.json", plan)
    agent = plan["method"]["agent"]
    run_dir = output / plan["nativePath"]
    if agent in RUNNERS:
        command = native_command(plan, output)
        write(output / "command.json", command)
        subprocess.run(command, check=True)
        checked_results(plan, read(run_dir / "results.json"))
    else:
        rows = [{"turn_id": t.get("turn_id", i), "context": t.get("context", ""),
                 "question": t["question"], "solution": (format_reference(t["answer"])
                  if agent == "oracle" else ""), "success": True,
                 "reasoning_summary": "Reference-answer replay" if agent == "oracle" else "",
                 "files_used": []} for i, t in enumerate(plan["turns"], 1)]
        write(run_dir / "results.json", rows)
        write(run_dir / "task_metadata.json", {
            **dict(zip(IDENTITY, plan["task"].split("/"))), "run_name": "orbit",
            "calibration": agent, "longds_version": plan["version"], "split": plan["split"]})


def format_reference(value):
    return json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)


def load_judge(solve_output, plan):
    for name, digest in plan["judgeSources"].items():
        path = solve_output / "upstream" / "src" / name
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError(f"Saved upstream judge source changed: {name}")
    path = solve_output / "upstream" / "src" / "judge.py"
    spec = importlib.util.spec_from_file_location("longds_original_judge", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify(solve_output, output, workers, retries):
    plan = read(solve_output / "selection.json")
    original = solve_output / plan["nativePath"]
    rows = checked_results(plan, read(original / "results.json"))
    # Reconstruct only grader input; ignore Agent-written ground truth or previous evaluation.
    rows = [{**row, "ground_truth": turn["answer"]} for row, turn in zip(rows, plan["turns"])]
    run_dir = output / "task"
    write(run_dir / "results_with_ground_truth.json", rows)
    shutil.copyfile(original / "task_metadata.json", run_dir / "task_metadata.json")
    judge = load_judge(solve_output, plan)
    turns = judge.load_run_turns(run_dir)
    needs_api = any(judge.format_for_prompt(t["solution"]).strip() for t in turns)
    model = os.environ.get("JUDGE_MODEL", "deepseek-v4-pro")
    client = None
    if needs_api:
        from openai import OpenAI
        if not os.environ.get("JUDGE_API_KEY") or not os.environ.get("JUDGE_BASE_URL"):
            raise ValueError("JUDGE_API_KEY and JUDGE_BASE_URL are required for nonempty answers")
        client = OpenAI(api_key=os.environ["JUDGE_API_KEY"], base_url=os.environ["JUDGE_BASE_URL"])
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(judge.judge_one, client, model, retries, t): t for t in turns}
        for future in concurrent.futures.as_completed(futures):
            futures[future]["judge"] = future.result()
    judge.write_run_outputs(turns)
    write(output / "summary.json", judge.summarize(turns))
    errors = [t for t in turns if t["judge"].get("error") is not None]
    (output / "review.md").write_text(
        f"# LongDS evaluation\n\nTask: `{plan['task']}`\n\n"
        f"Version: {plan['version']} / {plan['split']}\n\n"
        f"Turns: {len(turns)}; judge errors: {len(errors)}\n\n"
        f"Judge: `{model}`; original DataMind judge sources saved with solve output.\n",
        encoding="utf-8")
    if errors:
        raise ValueError(f"Original judge failed on {len(errors)}/{len(turns)} turns")


def main():
    output = Path(os.environ["ORBIT_OUTPUT"])
    output.mkdir(parents=True, exist_ok=True)
    if sys.argv[1] == "solve":
        solve(Path(sys.argv[2]), output)
    elif sys.argv[1] == "verify":
        verify(Path(sys.argv[2]), output, int(sys.argv[3]), int(sys.argv[4]))
    else:
        raise ValueError("Expected solve or verify")


if __name__ == "__main__":
    main()
