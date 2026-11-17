"""Run the original eval script and resolved decision without the upstream Docker launcher."""

import json
import os
import re
from pathlib import Path
import subprocess
import sys


def verify(src, solve, out):
    from swebench.harness.constants import MAP_REPO_VERSION_TO_SPECS, START_TEST_OUTPUT
    from swebench.harness.grading import get_eval_report
    from swebench.harness.run_evaluation import GIT_APPLY_CMDS
    from swebench.harness.test_spec.create_scripts import make_eval_script_list
    from swebench.harness.test_spec.test_spec import TestSpec

    row = json.loads((src / "instance.json").read_text())
    spec = MAP_REPO_VERSION_TO_SPECS[row["repo"]][row["version"]]
    criteria = {key: json.loads(row[key]) if isinstance(row[key], str) else row[key]
                for key in ("FAIL_TO_PASS", "PASS_TO_PASS")}
    # Images already contain the repository; the upstream eval script handles any reinstall.
    test_spec = TestSpec(instance_id=row["instance_id"], repo=row["repo"], version=row["version"],
        repo_script_list=[], env_script_list=[],
        eval_script_list=make_eval_script_list(row, spec, "testbed", "/testbed", row["base_commit"], row["test_patch"]),
        arch="x86_64", language="py", docker_specs=spec.get("docker_specs", {}), namespace="swebench", **criteria)
    patch_file = solve / "model.patch"
    patch = patch_file.read_text() if patch_file.is_file() else ""
    result = {"task": row["instance_id"], "resolved": False, "harnessVersion": "3.0.15"}
    if not patch.strip():
        result["reason"] = "empty_patch"
        return result
    subprocess.run(["git", "config", "--global", "--add", "safe.directory", "/testbed"], check=True)
    subprocess.run(["git", "reset", "--hard", row["base_commit"]], cwd="/testbed", check=True)
    applied = False
    with (out / "patch_output.txt").open("w") as log:
        for command in GIT_APPLY_CMDS:
            import shlex
            attempt = subprocess.run([*shlex.split(command), str(patch_file)], cwd="/testbed", stdout=log, stderr=subprocess.STDOUT)
            if attempt.returncode == 0:
                applied = True
                break
    if not applied:
        result["reason"] = "inapplicable_patch"
        return result
    script = out / "eval.sh"
    script.write_text(test_spec.eval_script)
    with (out / "test_output.txt").open("w") as log:
        test_env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
        process = subprocess.run(["bash", str(script)], cwd="/testbed", env=test_env, stdout=log, stderr=subprocess.STDOUT)
    log_text = (out / "test_output.txt").read_text()
    setup_text = log_text.split(START_TEST_OUTPUT)[0]
    if re.search(r"(?m)^error: subprocess-exited-with-error$|^ERROR: (Could not find a version|No matching distribution|Could not install packages|Failed building wheel)", setup_text):
        raise RuntimeError("Original evaluation setup failed; inspect test_output.txt")
    report = get_eval_report(test_spec, {"instance_id": row["instance_id"], "model_patch": patch,
        "model_name_or_path": "orbit"}, str(out / "test_output.txt"), include_tests_status=True)
    result.update(report[row["instance_id"]])
    result["evalExitCode"] = process.returncode
    return result


def run(mode, src=Path("/input"), solve=Path("/solve"), out=None):
    out = out or Path(os.environ["ORBIT_OUTPUT"])
    out.mkdir(parents=True, exist_ok=True)
    if mode in ("oracle", "empty"):
        item = json.loads((src / "task.json").read_text())
        (out / "model.patch").write_text(item["patch"] if mode == "oracle" else "")
        return
    item = json.loads((src / "task.json").read_text())
    try:
        result = verify(src, solve, out)
    except Exception as exc:
        result = {"task": item["task"], "error": f"{type(exc).__name__}: {exc}"}
    (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    run(sys.argv[1])
