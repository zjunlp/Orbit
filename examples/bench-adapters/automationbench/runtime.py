"""Run the pinned native AutomationBench agent and independently recheck its world."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

REVISION = "4a8e1061254004d9dac807054eed33fad7d1ff14"
PUBLIC = ["sales", "marketing", "operations", "support", "finance", "hr"]


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False))
    temporary.replace(path)


def rows(domains):
    from automationbench.domains import get_combined_dataset
    from automationbench.task_contract import task_contract_sha256

    result = []
    for row in get_combined_dataset(domains):
        info = row["info"]
        if isinstance(info, str):
            info = json.loads(info)
        row["info"] = info
        row["id"] = info["task_name"]
        row["contract"] = task_contract_sha256(
            example_id=row["example_id"], prompt=row["prompt"], info=info)
        result.append(row)
    return result


def evaluate(entry, final_world):
    from automationbench.runner import strip_none_values
    from automationbench.schema.world import WorldState
    from automationbench.rubric import partial_credit, task_completed_correctly
    from automationbench.rubric.registry import AssertionRegistry

    AssertionRegistry.reset_error_counts()
    state = {"info": strip_none_values(entry["info"]),
             "initial_state": strip_none_values(entry["info"]["initial_state"]),
             "world": WorldState(**final_world)}
    partial = partial_credit(state)
    if AssertionRegistry.get_error_summary():
        raise ValueError("Original assertion evaluator raised an error")
    return {"score": task_completed_correctly(state), "partial_credit": partial,
            "assertions": state["_assertion_results"]}


def solve(plan, output):
    from automationbench.runner import strip_none_values, compute_allowed_services
    from automationbench.schema.world import WorldState
    entry = next(e for e in rows([plan["domain"]]) if e["id"] == plan["task"])
    if entry["contract"] != plan["contract"]:
        raise ValueError("Native task differs from the registered catalog")
    if plan["method"] == "empty":
        initial = strip_none_values(entry["info"]["initial_state"])
        world = WorldState(**initial)
        world.meta.allowed_services = compute_allowed_services(
            initial, entry["info"]["assertions"], entry["info"]["zapier_tools"])
        row = {"name": entry["id"], "task_contract_sha256": entry["contract"],
               "end_state": world.model_dump(mode="json"), "messages": [], "steps": 0}
        write(output / "native.json", {"meta": {"method": "empty"}, "tasks": [row]})
        write(output / "execution.json", {"exit_code": 0, "method": "empty"})
        return
    args = ["auto-bench", "--model", plan["model"], "--domains", plan["domain"],
            "--tasks", plan["task"], "--max-concurrent", "1", "--max-steps", str(plan["maxSteps"]),
            "--toolset", "api", "--api-key-var", "AUTOMATIONBENCH_API_KEY",
            "--export-json", str(output / "native.json")]
    if plan.get("baseUrl"):
        args += ["--base-url", plan["baseUrl"]]
    if plan.get("effort"):
        args += ["--reasoning-effort", plan["effort"]]
    secret = os.environ.get("AUTOMATIONBENCH_API_KEY", "")
    if not secret:
        raise ValueError("AUTOMATIONBENCH_API_KEY must be passed to the native agent")
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in proc.stdout:
        print(line.replace(secret, "[REDACTED]"), end="", flush=True)
    code = proc.wait()
    write(output / "execution.json", {"exit_code": code, "method": "auto-bench"})
    if code:
        raise RuntimeError(f"Native runner exited {code}")


def verify(plan, output):
    from automationbench.export import is_aborted

    raw = Path("/solve/native.json").read_bytes()
    execution = json.loads(Path("/solve/execution.json").read_text())
    if execution.get("exit_code") != 0:
        raise ValueError("Native execution failed; no valid evaluation")
    data = json.loads(raw)
    if len(data.get("tasks", [])) != 1:
        raise ValueError("Expected exactly one native task")
    row = data["tasks"][0]
    if row["name"] != plan["task"] or row.get("task_contract_sha256", plan["contract"]) != plan["contract"]:
        raise ValueError("Native task identity or contract mismatch")
    if plan["method"] != "empty":
        if row.get("errors") or is_aborted(row, plan["maxSteps"]):
            raise ValueError("Native rollout reports an execution/API error or aborted tool turn")
        if not any(m.get("role") == "assistant" for m in row.get("messages", [])):
            raise ValueError("No model response in native rollout")
    entry = next(e for e in rows([plan["domain"]]) if e["id"] == plan["task"])
    if entry["contract"] != plan["contract"]:
        raise ValueError("Verifier task differs from the frozen contract")
    if plan["method"] != "empty":
        # The pinned CLI omits contract state_columns from its export. Its exact prompt is retained.
        plain = lambda ms: [{"role": m.get("role"), "content": m.get("content")} for m in ms]
        if plain(row["messages"][:len(entry["prompt"])]) != plain(entry["prompt"]):
            raise ValueError("Exported prompt differs from the frozen task")
        if data["meta"].get("benchmark_version") != "1.0.6" or data["meta"].get("toolset") != "api":
            raise ValueError("Unexpected native runner version or toolset")
    if not isinstance(row.get("end_state"), dict):
        raise ValueError("Native rollout has no final world")
    result = evaluate(entry, row["end_state"])
    result.update(task=plan["task"], contract=plan["contract"], revision=REVISION,
                  nativeSha256=hashlib.sha256(raw).hexdigest(), invalid=False)
    write(output / "verdict.json", result)


def main():
    output = Path(os.environ["ORBIT_OUTPUT"])
    output.mkdir(parents=True, exist_ok=True)
    if sys.argv[1] == "catalog":
        tasks = rows(PUBLIC + ["simple"])
        write(output / "catalog.json", {"revision": REVISION, "version": "1.0.6", "tasks": tasks})
        print(f"Exported {len(tasks)} original public and simple tasks")
        return
    plan = json.loads(Path("/plan.json").read_text())
    try:
        {"solve": solve, "verify": verify}[sys.argv[1]](plan, output)
    except Exception as exc:
        write(output / "verdict.json", {"invalid": True, "error": str(exc), "task": plan["task"]})
        raise


if __name__ == "__main__":
    main()
