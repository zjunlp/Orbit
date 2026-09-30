"""W01/W02 compatibility and HTTP integration with explicitly fake execution backends."""

import base64
import json
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection

import pytest

from agent_infra.projects.catalog import ProjectCatalogBridge
from agent_infra.projects.console import ProjectConsole
from agent_infra.projects.local import LocalProjectStore
from agent_infra.records.catalog import CatalogConflict
from tests.unit.runs.test_controller import wait_finished
from tests.web.workflow_fixture import TOKEN, fixture


@pytest.fixture
def app(tmp_path):
    with fixture(tmp_path) as data:
        yield data


def call(app, path, body=None, *, token=TOKEN):
    client = HTTPConnection("127.0.0.1", app["port"], timeout=10)
    client.request(
        "GET" if body is None else "POST",
        "/api/v1/" + path,
        body=None if body is None else json.dumps(body),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
    )
    response = client.getresponse()
    value = json.loads(response.read())
    status = response.status
    client.close()
    return status, value


def test_non_destructive_legacy_mapping_binding_and_missing_associations(app):
    workflow, root = app["workflow"], app["root"]
    catalog = workflow.projects.catalog
    original = catalog.list_projects()
    files = set(root.rglob("*"))
    before = call(app, "projects")[1]["items"]
    assert len(before) == 2 and before[0]["binding_status"] == "unbound"
    assert before[0]["task_mappings"][0]["resolved"]
    for _ in range(2):
        reopened = ProjectConsole(
            LocalProjectStore(root / "state/projects"),
            ProjectCatalogBridge(LocalProjectStore(root / "state/projects"), catalog.path),
        )
        assert len(reopened.list_projects(workflow.console.tasks())) == 2
    assert files == set(root.rglob("*"))  # Reading never makes a workspace or migrates documents.
    assert catalog.list_projects() == original
    path = f"projects/{app['legacy']}/bind"
    assert call(app, path, {"project_id": app["project"]})[0] == 200
    assert call(app, path, {"project_id": app["project"]})[0] == 200
    assert len(call(app, "projects")[1]["items"]) == 2
    assert catalog.list_projects() == original
    detail = call(app, f"projects/{app['legacy']}")[1]
    assert detail["project"]["goal"] == "保留旧目标"
    assert detail["research"]["accepted_revision"] == 1
    workflow.console.task_paths = ()
    unresolved = call(app, f"projects/{app['legacy']}")[1]["project"]
    assert not unresolved["task_mappings"][0]["resolved"]
    assert unresolved["task_mappings"][0]["identity"]
    # Editing metadata must not erase an unavailable task or old run link.
    workflow.console.save_project(
        {k: v for k, v in original[0].items() if k != "updated_at"} | {"name": "编辑后的标题"}
    )
    assert catalog.list_projects()[0]["task_keys"] == original[0]["task_keys"]
    with pytest.raises(CatalogConflict):
        catalog.bind(app["legacy"], "another-project")


def test_project_init_shared_store_idempotence_and_no_overwrite(app):
    directory = app["root"] / "created-by-web"
    body = {
        "name": "新的项目",
        "goal": "比较方法",
        "directory": str(directory),
        "operation_id": "web-init",
    }
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: call(app, "projects/init", body), range(2)))
    assert all(r[0] == 200 for r in results)
    assert results[0][1]["project_id"] == results[1][1]["project_id"]
    project = app["workflow"].projects.projects.get(str(directory))
    assert project.project_id == results[0][1]["project_id"]
    assert (directory / "docs").is_dir()
    assert call(app, "projects/init", body | {"goal": "different"})[0] == 409
    assert call(app, "projects/init", body | {"directory": "relative/path"})[0] == 400
    assert call(app, "projects", {"name": "new legacy row"})[0] == 400
    assert call(app, "projects/init", body, token="bad")[0] == 401
    app["workflow"].projects.store.update(project.project_id, expected_revision=1, title="待恢复")
    detail = call(app, f"projects/{project.project_id}")
    assert detail[0] == 200 and detail[1]["research_warning"]
    assert detail[1]["project"]["binding_status"] == "projection_pending"


def test_compile_preflight_submit_retry_cancel_and_refresh(app):
    project, task = app["project"], app["compiled"]["task"]
    base = f"projects/{project}"
    compiled = call(
        app,
        base + "/compile",
        {
            "experiment_id": "pilot",
            "research_revision": 1,
            "execution": "configs/experiments/pilot.yaml",
        },
    )
    assert compiled[0] == 200 and compiled[1]["compiled"] == json.loads(json.dumps(app["compiled"]))
    assert (
        call(app, base + "/compile", {"experiment_id": "pilot", "research_revision": 1})[1][
            "status"
        ]
        == "needs_input"
    )
    request = {
        "task_id": task["task_id"],
        "task_revision": task["revision"],
        "model": "explicit-fixture",
        "network": True,
    }
    assert call(app, "capabilities")[1]["run_control"]
    assert call(app, base + "/preflight", request)[1]["ready"]
    other = app["workflow"].projects.initialize(
        {
            "name": "Other",
            "goal": "other",
            "directory": str(app["root"] / "other"),
            "operation_id": "other-init",
        }
    )
    assert call(app, f"projects/{other['project_id']}/preflight", request)[0] == 400
    assert not app["env"].specs
    body = request | {"operation_id": "web-submit"}
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: call(app, base + "/submit", body), range(2)))
    assert all(r[0] == 200 for r in results), results
    run_id = results[0][1]["run_id"]
    assert results[1][1]["run_id"] == run_id
    path = f"execution/runs/{run_id}"
    assert call(app, path)[1]["state"] in {"accepted", "running"}
    assert any(r["run_id"] == run_id for r in call(app, base)[1]["runs"])
    assert call(app, path + "/cancel", {})[1]["cancel_requested"]
    final = wait_finished(app["control"], run_id)
    assert final["result"]["status"] == "cancelled"
    assert call(app, path)[1]["result"]["cleanup_complete"]
    assert call(app, base + "/submit", body)[1]["run_id"] == run_id
    # A stale plan is not silently accepted by the Web adapter.
    original = app["workflow"].projects.research.context
    app["workflow"].projects.research.context = lambda _: (
        original(project) | {"accepted_revision": 2}
    )
    assert call(app, base + "/submit", body | {"operation_id": "stale"})[0] == 400


def test_artifact_analysis_jobs_and_private_boundaries_offline(app):
    path = f"execution/runs/{app['finished']}"
    status, run = call(app, path)
    assert status == 200 and run["jobs"][0]["state"] == "exited"
    responses = [run, call(app, "execution/runs")[1], call(app, f"projects/{app['project']}")[1]]
    assert responses[-1]["analyses"][0]["evidence"][0]["metrics"][0]["value"] == 2
    artifacts = call(app, path + "/artifacts")[1]
    responses += [artifacts, call(app, path + "/events")[1]]
    assert len(artifacts["items"]) == 1
    assert "PRIVATE_W_SENTINEL" not in json.dumps(responses)
    member = path + f"/artifacts/{app['artifact']}"
    assert call(app, member)[1]["files"][0]["path"] == "metrics.json"
    data = call(app, member + "?member=metrics.json")[1]
    assert json.loads(base64.b64decode(data["content_base64"])) == {"mean": 2.0}
    assert call(app, member + "?member=../../project.yaml")[0] == 404
    assert call(app, path + f"/artifacts/{app['private']}")[0] == 404
    app["workflow"].controller = lambda *_: (_ for _ in ()).throw(ValueError("offline"))
    assert not call(app, "capabilities")[1]["run_control"]
    assert call(app, member)[0] == 200
    assert call(app, f"projects/{app['project']}")[0] == 200


def test_actual_web_command_uses_shared_state_without_controller(tmp_path):
    import re
    import select
    import subprocess
    import sys

    from tests.unit.projects.test_compilation import setup

    _, project, _ = setup(tmp_path)
    assets = tmp_path / "web"
    assets.mkdir()
    (assets / "index.html").write_text("Fixture assets only")
    process = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "from agent_infra.bootstrap.cli import main; main()",
            "web",
            "--state-dir",
            str(tmp_path / "state"),
            "--console-dir",
            str(tmp_path / "catalog"),
            "--web-root",
            str(assets),
            "--port",
            "0",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert select.select([process.stdout], [], [], 15)[0], "web failed to start"
        line = process.stdout.readline()
        address = re.search(r"127.0.0.1:(\d+)/#token=(\S+)", line)
        assert address, "web did not report a local address"
        app = {"port": int(address[1])}
        assert call(app, "projects", token=address[2])[1]["items"][0]["id"] == project
        capabilities = call(app, "capabilities", token=address[2])[1]
        assert capabilities["project_workspaces"] and not capabilities["run_control"]
        assert call(app, "execution/runs", token=address[2])[1]["items"] == []
        assert not (tmp_path / "state/controller/endpoint.json").exists()
        assert (tmp_path / "state/controller").stat().st_mode & 0o777 == 0o700
    finally:
        process.terminate()
        process.communicate(timeout=10)
