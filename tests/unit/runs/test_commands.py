import subprocess
from dataclasses import replace

import pytest

from agent_infra.contracts.files import content_digest
from agent_infra.environments.api import CleanupResult, Submission
from agent_infra.environments.execution_api import (
    ExecutionHandle,
    ExecutionObservation,
    Reconciliation,
)
from agent_infra.environments.workspace import snapshot_workspace
from agent_infra.records.local import LocalRecordsStore
from agent_infra.resources.api import AllocationStatus, LeaseCapacity, ResourceClaim
from agent_infra.resources.persistent import PersistentLeaseStore
from agent_infra.runs.command_api import CommandRequest
from agent_infra.runs.commands import CommandRuns
from agent_infra.runs.control_store import RunControlStore
from agent_infra.runs.query import RunQueries


class CommandBackend:
    """Deterministic execution double; no Docker or model is called."""

    backend_id = "docker-command-v1"
    features = ("cpu_memory_limits",)
    cleanup_scope = "test_only"

    def __init__(self, root):
        self.root, self.handles, self.launches = root, {}, 0
        self.done = False
        self.clean = True

    def submit(self, operation, spec):
        self.launches += 1
        handle = ExecutionHandle(operation, self.backend_id, "test-" + operation, spec.digest())
        self.handles[operation] = handle
        return handle

    def reconcile(self, operation):
        handle = self.handles.get(operation)
        return Reconciliation("known", handle) if handle else Reconciliation("not_submitted")

    def observe(self, handle, cursor=0):
        data = b"command output\n"[cursor:]
        return ExecutionObservation(
            "failed" if self.done else "running",
            3 if self.done else None,
            data,
            cursor + len(data),
            self.done,
            False,
            CleanupResult(self.clean),
        )

    def cleanup(self, handle):
        return CleanupResult(self.clean)

    def cancel(self, handle):
        self.done = True
        return self.cleanup(handle)

    def collect(self, handle):
        self.root.mkdir(exist_ok=True)
        (self.root / "partial.json").write_text('{"loss": 0.2}')
        return Submission(self.root, content_digest(self.root), ("partial.json",), ())


def command_service(tmp_path):
    source = tmp_path / "project"
    source.mkdir()
    (source / "train.py").write_text("print('first version')")
    records = LocalRecordsStore(tmp_path / "records")
    store = RunControlStore(tmp_path / "control")
    backend = CommandBackend(tmp_path / "result")
    leases = PersistentLeaseStore(tmp_path / "leases", LeaseCapacity(1, 2, 1024**3, 0))
    commands = CommandRuns(
        store,
        records,
        backend,
        tmp_path / "commands",
        leases,
        lambda _: "sha256:test-image",
        lambda _: None,
    )
    request = CommandRequest(
        project=str(source), image="python", argv=("python", "train.py"), memory_bytes=128 * 1024**2
    )
    return commands, request, backend, records, leases


def test_direct_command_retry_queue_failure_and_restart(tmp_path):
    commands, request, backend, records, leases = command_service(tmp_path)
    first = commands.submit("one", request)
    assert first["state"] == "running" and backend.launches == 1
    (tmp_path / "project/train.py").write_text("print('new version')")
    assert commands.submit("one", request)["run_id"] == first["run_id"]
    assert backend.launches == 1
    second = commands.submit("two", request)
    assert second["state"] == "queued"
    backend.done = True
    restarted = CommandRuns(
        commands.service.store,
        records,
        backend,
        commands.root,
        leases,
        lambda _: "sha256:test-image",
        lambda _: None,
    )
    finished = restarted.service.status(first["run_id"])
    assert finished["result"]["execution"] == "failed"
    assert finished["result"]["artifact_id"]
    assert finished["result"]["evaluation"] == "not_requested"
    artifact = RunQueries(commands.service.store, records).artifacts(first["run_id"])[0]
    text = RunQueries(commands.service.store, records).artifact_view(
        first["run_id"], artifact["artifact_id"], "partial.json"
    )
    assert "0.2" in text["text"]
    assert restarted.service.status(second["run_id"])["state"] == "finished"
    assert backend.launches == 2
    assert all(lease.state.value == "released" for lease in leases.list())


def test_cleanup_failure_holds_capacity_and_queued_cancel_never_launches(tmp_path):
    commands, request, backend, records, leases = command_service(tmp_path)
    first = commands.submit("one", request)
    backend.done, backend.clean = True, False
    assert commands.service.status(first["run_id"])["state"] == "quarantined"
    second = commands.submit("two", request)
    cancelled = commands.service.status(second["run_id"], cancel=True)
    assert cancelled["result"]["execution"] == "cancelled"
    assert backend.launches == 1
    assert leases.list()[0].state.value == "reconciling"


def test_snapshot_preserves_git_worktree_changes_and_excludes_data(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    subprocess.run(["git", "init", "-q", str(source)], check=True)
    (source / "script.py").write_text("print(1)")
    subprocess.run(["git", "-C", str(source), "add", "script.py"], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(source),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "base",
        ],
        check=True,
    )
    (source / "script.py").write_text("print(2)")
    (source / "extra.py").write_text("print(3)")
    (source / ".env").write_text("fake-token")
    (source / "data").mkdir()
    (source / "data/big.bin").write_bytes(b"dataset")
    metadata = snapshot_workspace(source, tmp_path / "snapshot")
    assert metadata["commit"] and metadata["untracked"] == ["extra.py"]
    assert sorted(metadata["files"]) == ["extra.py", "script.py"]
    assert "+print(2)" in (tmp_path / "snapshot/evidence/code.patch").read_text()
    assert not (tmp_path / "snapshot/source/.env").exists()


def test_snapshot_symlink_is_rejected(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "escape.py").symlink_to("/etc/passwd")
    with pytest.raises(ValueError, match="symlink"):
        snapshot_workspace(source, tmp_path / "snapshot")
    assert not (tmp_path / "snapshot").exists()


def test_shared_ledger_scopes_and_gpu_identity(tmp_path):
    capacity = LeaseCapacity(8, 4, 1024**3, 2)
    one = PersistentLeaseStore(tmp_path, capacity, scope="research")
    two = PersistentLeaseStore(tmp_path, capacity, scope="benchmark")
    one.configure(capacity)
    two.configure(capacity)
    base = ResourceClaim("one", "one", "docker", 3, 128 * 1024**2, 1, "local", ("GPU-one",))
    admitted = one.acquire(base)
    assert admitted.status == AllocationStatus.GRANTED
    assert (
        two.acquire(replace(base, request_id="two", owner_id="two", cpu_cores=2)).status
        == AllocationStatus.WAITING
    )
    assert (
        two.acquire(replace(base, request_id="three", owner_id="three", cpu_cores=1)).status
        == AllocationStatus.WAITING
    )
    assert (
        two.acquire(
            replace(
                base, request_id="four", owner_id="four", cpu_cores=1, gpu_device_ids=("GPU-two",)
            )
        ).status
        == AllocationStatus.GRANTED
    )
    assert len(one.list()) == len(two.list()) == 1


def test_native_identity_grace_never_relaunches_or_releases_early(tmp_path):
    from datetime import UTC, datetime, timedelta

    commands, request, backend, _, leases = command_service(tmp_path)
    original_submit = backend.submit
    ready = False

    def submit(operation, spec):
        handle = original_submit(operation, spec)
        backend.handles[operation] = replace(handle, native_id=None)
        return backend.handles[operation]

    def reconcile(operation):
        handle = backend.handles.get(operation)
        if handle is None:
            return Reconciliation("not_submitted")
        return Reconciliation("known" if ready else "unknown", handle, "identity pending")

    backend.submit = submit
    backend.reconcile = reconcile
    first = commands.submit("slow-identity", request)
    assert first["state"] == "submitting" and backend.launches == 1
    assert leases.list()[0].state.value == "allocated"
    commands.service.store.update(
        first["run_id"], launch_started_at=(datetime.now(UTC) - timedelta(seconds=11)).isoformat()
    )
    original_observe = backend.observe
    backend.observe = lambda handle, cursor=0: replace(
        original_observe(handle, cursor), status="unknown"
    )
    assert commands.service.status(first["run_id"])["state"] == "quarantined"
    assert backend.launches == 1 and leases.list()[0].state.value == "reconciling"
    ready = True
    backend.observe = original_observe
    backend.done = True
    operation = first["attempt_id"]
    backend.handles[operation] = replace(backend.handles[operation], native_id="confirmed-native")
    assert commands.service.status(first["run_id"])["state"] == "finished"
    assert backend.launches == 1 and leases.list()[0].state.value == "released"


@pytest.mark.parametrize("first_identified", [False, True])
def test_unbound_gpu_claim_cannot_overlap_an_identified_device(tmp_path, first_identified):
    leases = PersistentLeaseStore(tmp_path, LeaseCapacity(8, 4, 1024**3, 2))
    first = ResourceClaim(
        "one",
        "one",
        "docker",
        1,
        128 * 1024**2,
        1,
        "local",
        ("GPU-one",) if first_identified else (),
    )
    admitted = leases.acquire(first)
    assert admitted.status == AllocationStatus.GRANTED
    second = replace(
        first,
        request_id="two",
        owner_id="two",
        gpu_device_ids=() if first_identified else ("GPU-two",),
    )
    assert leases.acquire(second).status == AllocationStatus.WAITING
    leases.release(admitted.lease.lease_id, admitted.lease.owner_epoch, cleanup_confirmed=True)
    assert leases.acquire(second).status == AllocationStatus.GRANTED


def test_empty_public_snapshot_never_exports_private_git_diff(tmp_path):
    source = tmp_path / "private-only"
    source.mkdir()

    def git(*args):
        return subprocess.run(["git", "-C", str(source), *args], check=True, capture_output=True)

    git("init", "-q")
    source.joinpath(".env").write_text("PRIVATE_SNAPSHOT_SENTINEL=before")
    git("add", ".env")
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base")
    source.joinpath(".env").write_text("PRIVATE_SNAPSHOT_SENTINEL=after")
    destination = tmp_path / "private-snapshot"
    metadata = snapshot_workspace(source, destination)
    assert metadata["files"] == []
    assert destination.joinpath("evidence/code.patch").read_text() == ""
    assert destination.joinpath("evidence/staged.patch").read_text() == ""
    assert not destination.joinpath("source/.env").exists()


def test_derived_index_failure_does_not_hold_cleaned_resources(tmp_path):
    commands, request, backend, _, leases = command_service(tmp_path)

    def fail_index(artifact):
        raise OSError("derived index unavailable")

    commands.service.after_archive = fail_index
    backend.done = True
    run = commands.submit("index-failure", request)
    assert run["state"] == "finished"
    assert run["result"]["artifact_id"] and run["result"]["index_error"] == "OSError"
    assert leases.list()[0].state.value == "released"
