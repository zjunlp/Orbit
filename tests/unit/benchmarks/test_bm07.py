"""BM07 local delivery: evidence claims, safe Web projection and one-shot handoff."""

import argparse
import importlib
import json
from http.client import HTTPConnection
from pathlib import Path
from threading import Thread
from types import SimpleNamespace

import pytest

from agent_infra.benchmarks.api import AdapterIdentity, PlanRequest
from agent_infra.benchmarks.compatibility import CompatibilityEntry, CompatibilityMatrix
from agent_infra.benchmarks.execution import prepare_execution
from agent_infra.benchmarks.planning import freeze_plan
from agent_infra.benchmarks.registry import LoadedAdapter
from agent_infra.benchmarks.submission_api import NativeSubmissionPlan, NativeSubmissionReceipt
from agent_infra.bootstrap.benchmark_console import BenchmarkConsole
from agent_infra.bootstrap.benchmark_execution import execution_action
from agent_infra.bootstrap.node_resources import list_node_leases, node_leases
from agent_infra.gateways.http.server import create_server
from agent_infra.records.api import ArtifactRef, BlobRef, DataClass, Visibility
from agent_infra.resources.api import LeaseCapacity, ResourceClaim
from agent_infra.runs.benchmark_submission import BenchmarkSubmissionService
from agent_infra.runs.control_store import RunControlStore

EXAMPLE = Path(__file__).resolve().parents[3] / "examples/benchmark-execution"


def test_console_counts_only_its_shared_leases_without_writing(tmp_path):
    state = tmp_path / "state"
    root = state / "benchmarks"
    RunControlStore(root)
    before = set(tmp_path.rglob("*"))
    console = BenchmarkConsole(state)
    assert console.snapshot()["active_leases"] == 0
    assert list_node_leases(root) == ()
    assert set(tmp_path.rglob("*")) == before
    capacity = LeaseCapacity(2, 1, 1024**3, 0)
    own = node_leases(root, capacity)
    other = node_leases(tmp_path / "other/benchmarks", capacity)
    own.observe = other.observe = None  # Deterministic admission; no jobs are launched.
    first = own.acquire(ResourceClaim("one", "one", "fixture", 0.1, 1024, 0)).lease
    second = other.acquire(ResourceClaim("two", "two", "fixture", 0.1, 1024, 0)).lease
    assert first is not None and second is not None
    database_before = own.path.read_bytes()
    assert console.snapshot()["active_leases"] == 1
    assert own.path.read_bytes() == database_before
    own.release(first.lease_id, first.owner_epoch, cleanup_confirmed=True)
    assert console.snapshot()["active_leases"] == 0


@pytest.fixture
def prepared(monkeypatch):
    monkeypatch.syspath_prepend(str(EXAMPLE / "src"))
    adapter = importlib.import_module("agent_infra_benchmark_process_example").Adapter()
    identity = AdapterIdentity(
        distribution="agent-infra-benchmark-process-example",
        version="0.1.0",
        entry_point="process-demo",
        adapter_id="process-demo",
        sdk_version="1.0",
    )
    request = PlanRequest.model_validate_json((EXAMPLE / "request.json").read_bytes())
    execution = prepare_execution(
        freeze_plan(LoadedAdapter(adapter, identity), EXAMPLE / "fixture", request),
        LoadedAdapter(adapter, identity),
    )
    return execution, identity


def test_compatibility_matrix_requires_evidence_and_exact_enabled_identity(tmp_path, prepared):
    _, identity = prepared
    body = dict(
        alias="demo",
        adapter_id=identity.adapter_id,
        distribution=identity.distribution,
        adapter_version=identity.version,
        suite_digest="sha256:" + "1" * 64,
        runner_digest="sha256:" + "2" * 64,
        profile="synthetic",
        backend="managed-process-v1",
        agent="fixture",
        agent_version="1",
        model="none",
        level="runnable",
    )
    with pytest.raises(ValueError, match="require evidence"):
        CompatibilityEntry(**body)
    matrix = CompatibilityMatrix(entries=(CompatibilityEntry(**body, evidence=("doc:fixture",)),))
    file = tmp_path / "matrix.json"
    file.write_text(matrix.model_dump_json())
    registry = SimpleNamespace(load=lambda alias: SimpleNamespace(identity=identity))
    args = argparse.Namespace(
        benchmark_command="compatibility",
        compatibility_command="publish",
        state_dir=str(tmp_path / "state"),
        file=file,
        config=file,
    )
    assert execution_action(args, registry)["entries"] == 1
    args.compatibility_command = "show"
    assert execution_action(args, registry)["entries"][0]["evidence"] == ["doc:fixture"]
    empty = tmp_path / "untouched"
    args.state_dir = str(empty)
    assert execution_action(args, registry) == {"schema_version": 1, "entries": []}
    assert not empty.exists()
    args.state_dir = str(tmp_path / "state")
    wrong = CompatibilityMatrix(
        entries=(CompatibilityEntry(**{**body, "adapter_id": "other"}, evidence=("run:x",)),)
    )
    file.write_text(wrong.model_dump_json())
    args.compatibility_command = "publish"
    with pytest.raises(ValueError, match="differs from enabled"):
        execution_action(args, registry)


def test_submission_handoff_is_immutable_and_never_retries_unknown(tmp_path, prepared):
    execution, identity = prepared
    artifact = ArtifactRef(
        "artifact-1",
        "submission",
        "native-submission",
        "sha256:" + "3" * 64,
        4,
        "application/zip",
        BlobRef("sha256:" + "4" * 64, 10, "application/json"),
        Visibility.ADMIN,
        DataClass.INTERNAL,
    )

    class Records:
        def get_artifact(self, artifact_id):
            assert artifact_id == artifact.artifact_id
            return artifact

        def list_artifacts(self, attempt_id):
            assert attempt_id == "attempt-1"
            return (artifact,)

    service = BenchmarkSubmissionService(tmp_path / "submission", Records())
    run = {
        "run_id": "a" * 32,
        "attempt_id": "attempt-1",
        "state": "finished",
        "request": {"execution": execution.model_dump(mode="json")},
        "result": {
            "execution": "completed",
            "protocol": "valid",
            "cleanup_complete": True,
            "artifact_id": artifact.artifact_id,
            "native_result": {"evaluation": "scored", "private_answer": "HIDDEN"},
        },
    }

    def native_plan(plan, ref, result):
        return NativeSubmissionPlan(
            target="example-native",
            format="zip-v1",
            instructions=("Review native bundle before upload",),
            supports_send=True,
        )

    handoff = service.prepare(run, identity, native_plan)
    assert "HIDDEN" not in json.dumps(handoff)
    assert service.prepare(run, identity, native_plan) == handoff

    def lost_reply(*_):
        raise ConnectionError("remote accepted but reply lost")

    with pytest.raises(ConnectionError):
        service.send(run["run_id"], lost_reply)
    assert service.status(run["run_id"])["state"] == "unknown"
    with pytest.raises(ValueError, match="do not retry"):
        service.send(run["run_id"], lost_reply)
    another = {**run, "run_id": "b" * 32}
    service.prepare(another, identity, native_plan)
    delivered = service.send(
        another["run_id"],
        lambda *_: NativeSubmissionReceipt(
            status="submitted", native_submission_id="native-1", evidence_reference="receipt-1"
        ),
    )
    assert delivered["state"] == "submitted"
    assert delivered["receipt"]["native_submission_id"] == "native-1"


def test_benchmark_console_excludes_private_native_result_and_http_requires_auth(
    tmp_path, prepared
):
    execution, _ = prepared
    state = tmp_path / "state"
    store = RunControlStore(state / "benchmarks")
    run = store.create(
        "op", {"kind": "benchmark", "execution": execution.model_dump(mode="json")}, {}
    )
    store.update(
        run["run_id"],
        state="finished",
        result={"execution": "completed", "native_result": {"answer": "HIDDEN"}},
    )
    view = BenchmarkConsole(state)
    snapshot = view.snapshot()
    assert snapshot["runs"][0]["candidate_id"] == "process-fixture"
    assert "HIDDEN" not in json.dumps(snapshot)
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text("ok")
    token = "test-only-token-" * 3
    server = create_server(None, web, token, 0, benchmark=view)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        client.request("GET", "/api/v1/benchmarks")
        assert client.getresponse().status == 401
        client.close()
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        client.request("GET", "/api/v1/benchmarks", headers={"Authorization": "Bearer " + token})
        response = client.getresponse()
        assert response.status == 200 and b"process-fixture" in response.read()
        client.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
