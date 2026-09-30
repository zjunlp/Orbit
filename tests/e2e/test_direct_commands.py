"""Real CLI/HTTP/CPU Docker recovery; no Agent or model calls, at most 1 CPU/256 MiB."""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from agent_infra.gateways.cli.research_runtime import ResearchClient
from agent_infra.gateways.cli.runs import ControllerClient
from agent_infra.records.local import LocalRecordsStore
from agent_infra.records.metrics import MetricIndex
from agent_infra.runs.control_store import RunControlStore
from agent_infra.runs.query import RunQueries
from agent_infra.runs.review import ExperimentReviews

pytestmark = pytest.mark.e2e


def _daemon(root, state):
    code = """
import sys
from pathlib import Path
from agent_infra.bootstrap import controller
from agent_infra.runs.host_lock import HostControllerLock
state = Path(sys.argv[1])
controller.HostControllerLock = lambda value: HostControllerLock(
    value, namespace=state.parent / 'host-lock')
controller.serve_controller(state, port=0, cpu=1, memory_bytes=256*1024**2)
"""
    env = os.environ | {
        "AGENT_INFRA_NODE_STATE": str(root / "node"),
        "HTTPS_PROXY": "http://127.0.0.1:9",
    }
    log = (root / "daemon.log").open("a")
    process = subprocess.Popen(
        [sys.executable, "-c", code, str(state)], stdout=log, stderr=log, env=env
    )
    log.close()
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        assert process.poll() is None, (root / "daemon.log").read_text()
        try:
            client = ControllerClient(state)
            if client.request("health", timeout=1)["ready"]:
                return process, client
        except ValueError:
            pass
        time.sleep(0.1)
    process.terminate()
    process.wait(10)
    raise AssertionError("controller startup timed out")


def _wait(client, run_id, seconds=45):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = client.request("runs/" + run_id)
        if value["state"] == "finished":
            return value
        time.sleep(0.1)
    raise AssertionError(f"command did not finish: {value}")


def test_real_command_survives_controller_restart_and_records_failed_partial_outputs(tmp_path):
    state, workspace = tmp_path / "state", tmp_path / "workspace"
    workspace.mkdir()
    script = workspace / "train.py"
    script.write_text(
        "import os,time\nfrom pathlib import Path\np=Path(os.environ['INFRA_OUTPUT'])\n"
        "p.joinpath('started').write_text('once')\nprint('started',flush=True)\ntime.sleep(5)\n"
        "p.joinpath('metrics.jsonl').write_text('{\"step\":1,\"loss\":0.25}\\n')\n"
        "print('final-tail',flush=True)\n"
    )
    process, client = _daemon(tmp_path, state)
    run_id = None
    try:
        command = [
            str(Path(sys.executable).parent / "agent-infra"),
            "run",
            "command",
            "--state-dir",
            str(state),
            "--project",
            str(workspace),
            "--name",
            "CPU recovery",
            "--image",
            "python:3.12-slim",
            "--cpu",
            "1",
            "--memory-gib",
            "0.25",
            "--timeout",
            "30",
            "--operation-id",
            "restart-once",
            "--",
            "python",
            "train.py",
        ]
        launched = subprocess.run(command, capture_output=True, text=True, timeout=30, check=True)
        run = json.loads(launched.stdout)
        run_id = run["run_id"]
        deadline = time.monotonic() + 20
        while not list((state / "controller/commands/workspaces").glob("**/outputs/started")):
            assert time.monotonic() < deadline, client.request("runs/" + run_id)
            time.sleep(0.1)
        before = client.request("runs/" + run_id)
        process.kill()
        process.wait(10)
        process, client = _daemon(tmp_path, state)
        duplicate = json.loads(
            subprocess.run(command, capture_output=True, text=True, timeout=30, check=True).stdout
        )
        assert duplicate["run_id"] == run_id
        finished = _wait(client, run_id)
        assert finished["result"]["execution"] == "completed", finished
        assert finished["result"]["exit_code"] == 0 and finished["result"]["cleanup_complete"]
        assert finished["lease_id"] == before["lease_id"] and finished["lease_state"] == "released"
        records = LocalRecordsStore(state / "controller/records")
        queries = RunQueries(RunControlStore(state / "controller"), records)
        review = ExperimentReviews(queries, MetricIndex(records).read).get(run_id)
        assert review.metrics.series[0].points[0].value == 0.25
        assert "train.py" in review.code.files
        assert finished["result"]["capture"] == "complete"
        stream = finished["result"]["stream"]["blob"]
        from agent_infra.records.api import BlobRef

        with records.open_blob(BlobRef(**stream)) as log:
            assert b"final-tail" in log.read()
        research = ResearchClient(state, finished["lineage"]["project_id"], "test-session")
        artifact = research.call("artifacts", run_id=run_id)["items"][0]
        files = research.call("artifact", run_id=run_id, artifact_id=artifact["artifact_id"])[
            "files"
        ]
        metric = next(item["path"] for item in files if item["path"].endswith("/metrics.jsonl"))
        viewed = research.call(
            "artifact",
            run_id=run_id,
            artifact_id=artifact["artifact_id"],
            member=metric,
            format="auto",
        )
        assert "0.25" in viewed["text"] and "content_base64" not in viewed
        script.write_text(
            "from pathlib import Path\nPath('outputs/partial.txt').write_text('preserved')\n"
            "raise SystemExit(3)\n"
        )
        rerun = client.request("runs/" + run_id + "/rerun", {"operation_id": "rerun-current-code"})
        failed = _wait(client, rerun["run_id"])
        assert failed["result"]["execution"] == "failed" and failed["result"]["exit_code"] == 3
        assert failed["lineage"]["parent_run_id"] == run_id
        assert failed["lineage"]["code"]["digest"] != finished["lineage"]["code"]["digest"]
        assert failed["result"]["artifact_id"] and failed["lease_state"] == "released"
        waited = subprocess.run(
            [command[0], "run", "wait", failed["run_id"], "--state-dir", str(state)],
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert waited.returncode == 3
        assert len(RunControlStore(state / "controller").list_runs()) == 2
    finally:
        if process.poll() is None:
            for pending in RunControlStore(state / "controller").unfinished():
                client.request("runs/" + pending["run_id"] + "/cancel", {})
                _wait(client, pending["run_id"])
            process.terminate()
            process.wait(40)


def test_real_command_cancel_and_timeout_keep_partial_evidence(tmp_path):
    state, workspace = tmp_path / "state", tmp_path / "workspace"
    workspace.mkdir()
    workspace.joinpath("slow.py").write_text(
        "import time\nfrom pathlib import Path\n"
        "Path('outputs/ready').write_text('partial evidence')\n"
        "print('before stop',flush=True)\ntime.sleep(60)\n"
    )
    process, client = _daemon(tmp_path, state)
    try:
        body = {
            "project": str(workspace),
            "image": "python:3.12-slim",
            "argv": ["python", "slow.py"],
            "cpu_cores": 1,
            "memory_bytes": 256 * 1024**2,
            "timeout_seconds": 30,
        }
        run = client.request("runs/command", body | {"operation_id": "cancel-command"})
        deadline = time.monotonic() + 20
        ready = state / "controller/commands/workspaces" / run["run_id"] / "outputs/ready"
        while not ready.exists():
            assert time.monotonic() < deadline
            time.sleep(0.1)
        client.request("runs/" + run["run_id"] + "/cancel", {})
        stopped = _wait(client, run["run_id"])
        assert (
            stopped["result"]["execution"] == "cancelled" and stopped["lease_state"] == "released"
        )
        assert stopped["result"]["artifact_id"]
        timed = client.request(
            "runs/command", body | {"operation_id": "timeout-command", "timeout_seconds": 1}
        )
        finished = _wait(client, timed["run_id"])
        assert finished["result"]["execution"] == "timed_out", finished
        assert finished["result"]["artifact_id"] and finished["lease_state"] == "released"
    finally:
        for pending in RunControlStore(state / "controller").unfinished():
            client.request("runs/" + pending["run_id"] + "/cancel", {})
            _wait(client, pending["run_id"])
        process.terminate()
        process.wait(40)
