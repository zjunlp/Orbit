"""Real local persistence/HTTP tests; fixture events are not Agent execution evidence."""

import json
from datetime import UTC, datetime, timedelta
from http.client import HTTPConnection
from pathlib import Path
from threading import Thread

import pytest

from agent_infra.agents.presentation import event_text
from agent_infra.gateways.http.server import create_server
from agent_infra.projects.catalog import ProjectCatalogBridge
from agent_infra.projects.local import LocalProjectStore
from agent_infra.records import (
    AttemptManifest,
    EventDraft,
    ProducerKind,
    RecordContext,
    RunManifest,
)
from agent_infra.records.api import DataClass, Visibility
from agent_infra.records.catalog import CatalogConflict
from agent_infra.records.local import LocalRecordsStore
from agent_infra.resources.api import HostResourceSnapshot
from agent_infra.resources.sampling import ResourceSampler
from agent_infra.runs.console import ConsoleService

TASK = Path("examples/task-packages/file-result/task.yaml")


@pytest.fixture
def service(tmp_path):
    store = LocalRecordsStore(tmp_path / "records")
    now = datetime.now(UTC)
    store.begin_run(RunManifest("run-fixture", now, {"credential_path": "HIDDEN"}))
    store.begin_attempt(AttemptManifest("attempt-fixture", "run-fixture", now, "task", "digest"))
    return ConsoleService(
        store,
        ProjectCatalogBridge(
            LocalProjectStore(tmp_path / "projects"), tmp_path / "projects.sqlite3"
        ),
        lambda: {},
        lambda: [],
        (TASK,),
    )


def test_project_persistence_revision_conflict_and_links(service, tmp_path):
    task = service.tasks()[0]
    assert task["error"] is None
    assert set(task["resource_intent"]) == {"state", "constraints"}
    assert "provenance" not in json.dumps(task)
    project = service.save_project(
        {
            "name": "实验一",
            "run_ids": ["run-fixture"],
            "task_keys": [task["key"]],
            "milestones": [{"title": "训练完成", "done": False}],
        }
    )
    assert project["revision"] == 1
    draft = {k: v for k, v in project.items() if k != "updated_at"}
    assert service.save_project(draft | {"status": "active"})["revision"] == 2
    with pytest.raises(CatalogConflict):
        service.save_project(draft)
    reopened = ProjectCatalogBridge(
        LocalProjectStore(tmp_path / "projects"), tmp_path / "projects.sqlite3"
    )
    assert reopened.list_projects()[0]["status"] == "active"
    with pytest.raises(KeyError):
        service.save_project({"name": "bad", "run_ids": ["missing"]})
    assert [r.manifest.run_id for r in service.reader.list_runs()] == ["run-fixture"]
    assert service.reader.list_runs(offset=1) == ()
    with pytest.raises(ValueError):
        service.reader.list_runs(offset=-1)


def test_no_private_materials_events_artifacts_or_raw_references(service, tmp_path):
    sink = service.reader.scoped_sink(
        RecordContext("run-fixture", "attempt-fixture", "agent", ProducerKind.AGENT)
    )
    sink.append_events(
        (
            EventDraft(
                "agent.message",
                {
                    "role": "assistant",
                    "text": "hello",
                    "native": {"message": {"content": [{"text": "hello"}]}},
                },
                raw_refs=("HIDDEN-REF",),
            ),
            EventDraft(
                "tool.requested",
                {
                    "tool_call_id": "call-1",
                    "tool_name": "read_pdf",
                    "tool_type": "function",
                    "arguments": {"path": "HIDDEN-PATH"},
                    "native": {"provider_private": "HIDDEN-NATIVE"},
                },
            ),
            EventDraft(
                "agent.message", {"native": {"text": "HIDDEN-SECRET"}}, data_class=DataClass.SECRET
            ),
            EventDraft(
                "agent.message",
                {"native": {"text": "HIDDEN-EVAL"}},
                visibility=Visibility.EVALUATOR,
            ),
        )
    )
    platform = service.reader.scoped_sink(
        RecordContext("run-fixture", "attempt-fixture", "environment", ProducerKind.ENVIRONMENT)
    )
    platform.append_events(
        (
            EventDraft(
                "tool.requested",
                {
                    "tool_call_id": "platform-call-1",
                    "tool_name": "start",
                    "arguments": {"command": "HIDDEN-COMMAND"},
                    "payload_blob": "HIDDEN-BLOB-REF",
                },
            ),
            EventDraft(
                "tool.completed",
                {
                    "tool_call_id": "platform-call-1",
                    "tool_name": "start",
                    "result": "HIDDEN-RESULT",
                },
            ),
        )
    )
    artifact = tmp_path / "result.txt"
    artifact.write_text("private body")
    sink.commit_artifact(artifact, name="public-result")
    sink.commit_artifact(artifact, name="HIDDEN-ARTIFACT", data_class=DataClass.PRIVATE_EVALUATION)
    payload = json.dumps(
        {
            "tasks": service.tasks(),
            "run": service.run_detail("run-fixture"),
            "events": service.events("attempt-fixture", None),
            "artifacts": service.artifacts("attempt-fixture"),
        }
    )
    assert "HIDDEN" not in payload
    assert "private/expected.txt" not in payload and "Private fixture answer" not in payload
    assert "hello" in payload and "read_pdf" in payload and "public-result" in payload
    assert "platform-call-1" in payload and '"coverage": {}' in payload
    assert "raw_refs" not in payload and "blob" not in payload
    with pytest.raises(KeyError):
        service.events("absent", None)


def test_http_auth_host_traversal_and_project_roundtrip(service, tmp_path):
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text("<h1>Fixture</h1>")
    token = "test-only-token-" * 3
    server = create_server(service, web, token, 0)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def call(path, method="GET", body=None, auth=True, host=None):
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        headers = {"Content-Type": "application/json"}
        if auth:
            headers["Authorization"] = "Bearer " + token
        if host:
            headers["Host"] = host
        client.request(method, path, body=json.dumps(body) if body else None, headers=headers)
        response = client.getresponse()
        data = response.read()
        status = response.status
        client.close()
        return status, data

    try:
        assert call("/api/v1/runs", auth=False)[0] == 401
        assert call("/api/v1/runs", host="evil.example")[0] == 403
        assert call("/../projects.sqlite3")[0] == 404
        assert call("/")[0] == 200
        assert call("/api/v1/runs")[0] == 200
        assert call("/api/v1/runs?offset=-1")[0] == 400
        assert call("/api/v1/runs/missing")[0] == 404
        assert call("/api/v1/tasks")[0] == 200
        status, data = call("/api/v1/projects", "POST", {"name": "HTTP project"})
        assert status == 200 and json.loads(data)["revision"] == 1
        assert b"HTTP project" in call("/api/v1/projects")[1]
        assert call("/api/v1/runs/run-fixture/cancel", "POST", {})[0] == 404
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_shared_sampler_is_bounded_preserves_unknown_and_reports_staleness():
    calls = 0
    failed = False

    def sample():
        nonlocal calls
        calls += 1
        if failed:
            raise RuntimeError("private driver detail")
        return HostResourceSnapshot(
            "fixture", datetime.now(UTC) - timedelta(seconds=30), 2, None, None, 100, 50
        )

    sampler = ResourceSampler(sample)
    for _ in range(452):
        sampler.collect()
    result = sampler.read()
    assert len(result["history"]) == 450
    assert result["latest"]["cpu_utilization_percent"] is None
    assert result["stale"]
    for _ in range(5):
        sampler.read()
    assert calls == 452
    failed = True
    sampler.collect()
    assert sampler.read()["error"] and "private" not in json.dumps(sampler.read())
    assert (
        event_text({"native": {"item": {"command": "echo hi", "aggregated_output": "hi"}}})
        == "echo hi\nhi"
    )
