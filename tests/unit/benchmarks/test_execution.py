"""Freeze-before-run and backend restrictions, without executing native commands."""

import argparse
import importlib
import json
import shutil
from dataclasses import replace
from pathlib import Path

import pytest

from agent_infra.benchmarks.api import AdapterIdentity, PlanRequest
from agent_infra.benchmarks.execution import (
    execution_spec,
    prepare_execution,
    read_execution,
    validate_backend,
    write_execution,
)
from agent_infra.benchmarks.execution_api import NativeInvocation
from agent_infra.benchmarks.planning import freeze_plan
from agent_infra.benchmarks.registry import AdapterError, LoadedAdapter
from agent_infra.bootstrap.benchmark_execution import execution_action
from agent_infra.bootstrap.benchmarks import benchmark_action
from agent_infra.environments.execution_api import ExecutionSpec
from agent_infra.environments.managed_process import ManagedProcessBackend

EXAMPLE = Path(__file__).resolve().parents[3] / "examples/benchmark-execution"


@pytest.fixture
def prepared(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(EXAMPLE / "src"))
    adapter = importlib.import_module("agent_infra_benchmark_process_example").Adapter()
    loaded = LoadedAdapter(
        adapter,
        AdapterIdentity(
            distribution="agent-infra-benchmark-process-example",
            version="0.1.0",
            entry_point="process-demo",
            adapter_id="process-demo",
            sdk_version="1.0",
        ),
    )
    source = tmp_path / "source"
    shutil.copytree(EXAMPLE / "fixture", source)
    request = PlanRequest.model_validate_json((EXAMPLE / "request.json").read_bytes())
    frozen = freeze_plan(loaded, source, request)
    return prepare_execution(frozen, loaded), loaded, source


def test_prepared_file_detects_tampering_and_never_overwrites(prepared, tmp_path):
    execution, _, _ = prepared
    path = tmp_path / "execution.json"
    write_execution(execution, path)
    assert read_execution(path) == execution and path.stat().st_mode & 0o777 == 0o600
    with pytest.raises(FileExistsError):
        write_execution(execution, path)
    body = json.loads(path.read_bytes())
    body["invocation"]["command"]["argv"][-1] = "changed"
    path.write_text(json.dumps(body))
    with pytest.raises(AdapterError, match="digest mismatch"):
        read_execution(path)


def test_planning_only_adapter_and_source_drift_are_rejected(prepared, monkeypatch):
    execution, loaded, source = prepared
    with monkeypatch.context() as scoped:
        scoped.setattr(loaded.implementation, "invocation", None)
        with pytest.raises(AdapterError, match="planning only"):
            prepare_execution(execution.frozen_plan, loaded)
    original = loaded.implementation.invocation

    def mutating(plan):
        invocation = original(plan)
        (source / "input.json").write_text('{"numbers": [9]}')
        return invocation

    monkeypatch.setattr(loaded.implementation, "invocation", mutating)
    with pytest.raises(AdapterError, match="source changed"):
        prepare_execution(execution.frozen_plan, loaded)


@pytest.mark.parametrize(
    ("patch", "message"),
    [
        ({"resources": {"cpu_cores": 1}}, "allocations"),
        ({"resources": {"gpu_count": 1}}, "allocations"),
        ({"resources": {"allocator": "external"}}, "allocations"),
        ({"budget": {"wall_seconds": 30, "clock": "first_model_call"}}, "budget/clock"),
        ({"budget": {"wall_seconds": 1, "clock": "process_start"}}, "budget/clock"),
        ({"owner": "platform"}, "native-owned"),
        ({"backend": "docker"}, "capabilities"),
    ],
)
def test_unsupported_native_requirements_fail_closed(prepared, patch, message):
    execution, _, _ = prepared
    body = execution.model_dump(mode="json")
    body["frozen_plan"]["plan"]["phases"][0].update(patch)
    modified = type(execution).model_validate_json(json.dumps(body))
    with pytest.raises(ValueError, match=message):
        validate_backend(modified, ManagedProcessBackend.backend_id, ManagedProcessBackend.features)


def test_private_materials_and_platform_retries_are_not_silently_ignored(prepared):
    execution, _, _ = prepared
    body = execution.model_dump(mode="json")
    plan = body["frozen_plan"]["plan"]
    plan["phases"][0]["materials"] = [
        {
            "material_id": "answers",
            "source": plan["suite"]["source"],
            "purpose": "score",
            "readers": ["grader"],
        }
    ]
    with pytest.raises(ValueError, match="private"):
        validate_backend(
            type(execution).model_validate_json(json.dumps(body)),
            ManagedProcessBackend.backend_id,
            ManagedProcessBackend.features,
        )
    plan["phases"][0]["materials"] = []
    plan["retry"]["owner"] = "platform"
    with pytest.raises(ValueError, match="retries"):
        validate_backend(
            type(execution).model_validate_json(json.dumps(body)),
            ManagedProcessBackend.backend_id,
            ManagedProcessBackend.features,
        )


@pytest.mark.parametrize("change", [{"outputs": ("../escape",)}, {"outputs": ("x", "x")}])
def test_output_paths_are_validated_before_launch(prepared, tmp_path, change):
    execution, _, _ = prepared
    spec = execution_spec(execution, "run", "attempt", tmp_path / "work")
    with pytest.raises(ValueError):
        ExecutionSpec.model_validate_json(spec.model_copy(update=change).model_dump_json())
    command = replace(spec.command, environment=(("SECRET", "example"),))
    with pytest.raises(ValueError, match="credential"):
        ExecutionSpec.model_validate_json(
            spec.model_copy(update={"command": command}).model_dump_json()
        )


def test_adapter_can_raise_bounded_capture_limits(prepared, tmp_path):
    execution, _, _ = prepared
    invocation = NativeInvocation(
        command=execution.invocation.command,
        outputs=execution.invocation.outputs,
        max_log_bytes=12 * 1024**2,
        max_artifact_bytes=48 * 1024**2,
    )
    expanded = execution.model_copy(update={"invocation": invocation})
    spec = execution_spec(expanded, "run", "attempt", tmp_path / "work")

    assert spec.max_log_bytes == 12 * 1024**2
    assert spec.max_artifact_bytes == 48 * 1024**2
    defaults = NativeInvocation(command=execution.invocation.command)
    assert "max_log_bytes" not in defaults.model_dump(mode="json")
    assert "max_artifact_bytes" not in defaults.model_dump(mode="json")


def test_benchmark_capacity_command_persists_and_rejects_unknown_fields(tmp_path):
    file = tmp_path / "capacity.json"
    file.write_text('{"max_concurrent": 2, "cpu_cores": 4, "memory_bytes": 8589934592}')
    args = argparse.Namespace(
        benchmark_command="capacity", state_dir=str(tmp_path / "state"), file=file, config=None
    )
    configured = execution_action(args, None)
    assert configured["capacity"]["max_concurrent"] == 2
    queued = execution_action(
        argparse.Namespace(benchmark_command="queue", state_dir=str(tmp_path / "state")), None
    )
    assert queued["capacity"] == configured["capacity"]
    assert benchmark_action(args)["capacity"] == configured["capacity"]
    file.write_text('{"max_concurrent": 3, "unexpected": true}')
    with pytest.raises(ValueError, match="unsupported fields"):
        execution_action(args, None)


def test_empty_worker_exits_and_rejects_unbounded_poll_interval(tmp_path):
    args = argparse.Namespace(
        benchmark_command="worker",
        state_dir=str(tmp_path / "state"),
        poll_seconds=0.1,
        max_seconds=1,
        until_empty=True,
    )
    assert execution_action(args, None)["pending"] == 0
    args.poll_seconds = 0
    with pytest.raises(ValueError, match="poll interval"):
        execution_action(args, None)


def test_external_backend_can_declare_multi_day_timeout(prepared, tmp_path):
    execution, _, _ = prepared
    command = replace(execution.invocation.command, timeout_seconds=3 * 86400)
    invocation = NativeInvocation(command=command, outputs=execution.invocation.outputs)
    expanded = execution.model_copy(update={"invocation": invocation})

    assert execution_spec(expanded, "run", "attempt", tmp_path / "work").command == command
    invalid = replace(command, timeout_seconds=8 * 86400)
    with pytest.raises(ValueError, match="604800"):
        ExecutionSpec.model_validate_json(
            execution_spec(expanded, "run", "attempt", tmp_path / "other")
            .model_copy(update={"command": invalid})
            .model_dump_json()
        )


def test_cli_requires_opt_in_before_import_or_state_creation(tmp_path):
    class Registry:
        def load_identity(self, identity):
            pytest.fail("execution adapter must not be loaded without host-process opt-in")

    args = argparse.Namespace(
        benchmark_command="run", allow_host_process=False, state_dir=str(tmp_path / "state")
    )
    with pytest.raises(ValueError, match="allow-host-process"):
        execution_action(args, Registry())
    assert not (tmp_path / "state").exists()


def test_external_job_does_not_block_shared_local_admission(prepared, tmp_path, monkeypatch):
    from agent_infra.bootstrap import benchmark_execution
    from agent_infra.resources.api import LeaseCapacity, ResourceClaim
    from agent_infra.resources.persistent import PersistentLeaseStore

    execution, _, _ = prepared
    path = tmp_path / "execution.json"
    write_execution(execution, path)
    root = tmp_path / "state/benchmarks"
    legacy = PersistentLeaseStore(root / "leases", LeaseCapacity(3, 4, 1024**3, 0))
    legacy.acquire(ResourceClaim("remote", "remote", "external", 1, 128 * 1024**2, 0, "external"))
    monkeypatch.setattr(benchmark_execution, "_validate_submission", lambda *args: None)
    domains = []

    class NoLaunchService:
        def __init__(self, *args, leases):
            domains.append(leases.path)

        def submit(self, *args, **kwargs):
            return {"queued": True}

    monkeypatch.setattr(benchmark_execution, "BenchmarkExecutionService", NoLaunchService)
    args = argparse.Namespace(
        benchmark_command="run",
        state_dir=str(root.parent),
        allow_host_process=True,
        execution=path,
        operation_id="new-local",
        budget_group=None,
        budget_wall_seconds=None,
    )
    assert execution_action(args, None)["queued"]
    assert domains[0] != legacy.path
    legacy.acquire(ResourceClaim("old-local", "old-local", "process", 1, 128 * 1024**2, 0, "local"))
    with pytest.raises(ValueError, match="legacy leases"):
        execution_action(args, None)
