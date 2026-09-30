"""Durable command launcher reusing the process supervisor and Docker isolation backend."""

import hashlib
import json
import sys
from dataclasses import replace
from pathlib import Path

from agent_infra.environments.api import CleanupResult, ProcessCommand, Submission
from agent_infra.environments.command_api import CommandExecutionSpec
from agent_infra.environments.execution_api import (
    ExecutionHandle,
    ExecutionObservation,
    ExecutionSpec,
    Reconciliation,
    ResourceAllocation,
)
from agent_infra.environments.managed_process import ManagedProcessBackend
from agent_infra.environments.recovery import (
    local_docker_endpoint,
    recover_owned_containers,
    write_ownership,
)


class DockerCommandBackend:
    backend_id = "docker-command-v1"
    cleanup_scope = "owned_process_and_container"
    features: tuple[str, ...] = (
        "durable_operation",
        "bounded_logs",
        "cpu_memory_limits",
        "wall_timeout",
    )

    def __init__(self, root: Path, *, gpu_mode: str = "legacy") -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.process = ManagedProcessBackend(self.root / "processes")
        self.gpu_mode = gpu_mode

    def _root(self, operation: str) -> Path:
        return self.root / hashlib.sha256(operation.encode()).hexdigest()

    def submit(self, operation_id: str, spec: ExecutionSpec) -> ExecutionHandle:
        command = CommandExecutionSpec.model_validate_json(spec.model_dump_json())
        root = self._root(operation_id)
        root.mkdir(exist_ok=True, mode=0o700)
        path = root / "command.json"
        if path.exists():
            if CommandExecutionSpec.model_validate_json(path.read_bytes()) != command:
                raise ValueError("operation already has a different Docker command")
        else:
            write_ownership(path, command.model_dump(mode="json"))
        transport = root / "transport.json"
        if not transport.exists():
            write_ownership(transport, {"docker_host": local_docker_endpoint()})
        launcher = ExecutionSpec(
            run_id=spec.run_id,
            attempt_id=spec.attempt_id,
            unit_id=spec.unit_id,
            phase_id=spec.phase_id,
            workspace=spec.workspace,
            command=ProcessCommand(
                (
                    sys.executable,
                    "-m",
                    "agent_infra.environments._command_runner",
                    str(root),
                    self.gpu_mode,
                ),
                cwd=".",
                timeout_seconds=min(604800, spec.command.timeout_seconds + 90),
            ),
            outputs=spec.outputs + (".infra-evidence",),
            cancellation_grace_seconds=30,
            max_log_bytes=spec.max_log_bytes,
            max_artifact_bytes=spec.max_artifact_bytes,
        )
        self.process.submit(operation_id, launcher)
        return ExecutionHandle(operation_id, self.backend_id, None, command.digest())

    def reconcile(self, operation_id: str) -> Reconciliation:
        receipt = self.process.reconcile(operation_id)
        if receipt.handle is None:
            return receipt
        root = self._root(operation_id)
        spec = CommandExecutionSpec.model_validate_json((root / "command.json").read_bytes())
        handle = ExecutionHandle(
            operation_id, self.backend_id, receipt.handle.native_id, spec.digest()
        )
        return Reconciliation(receipt.state, handle, receipt.reason)

    def _handle(self, handle: ExecutionHandle) -> ExecutionHandle:
        current = self.reconcile(handle.operation_id).handle
        if (
            current is None
            or current.spec_digest != handle.spec_digest
            or handle.backend != self.backend_id
        ):
            raise ValueError("Docker command identity mismatch")
        if handle.native_id is not None and handle.native_id != current.native_id:
            raise ValueError("Docker command supervisor identity changed")
        native = self.process.reconcile(handle.operation_id).handle
        assert native is not None
        return native

    def observe(self, handle: ExecutionHandle, cursor: int = 0) -> ExecutionObservation:
        observation = self.process.observe(self._handle(handle), cursor)
        path = self._root(handle.operation_id) / "result.json"
        if not path.exists():
            return replace(
                observation, logs_truncated=observation.logs_truncated or observation.eof
            )
        result = json.loads(path.read_text())
        allocation = result.get("allocation")
        return replace(
            observation,
            exit_code=result.get("exit_code") if observation.eof else observation.exit_code,
            status=result["status"]
            if observation.eof and observation.status != "cancelled"
            else observation.status,
            logs_truncated=observation.logs_truncated or result["logs_truncated"],
            allocation=ResourceAllocation(**allocation) if allocation else None,
        )

    def cancel(self, handle: ExecutionHandle) -> CleanupResult:
        self.process.cancel(self._handle(handle))
        return self.cleanup(handle)

    def cleanup(self, handle: ExecutionHandle) -> CleanupResult:
        result = self.process.cleanup(self._handle(handle))
        if not result.complete:
            return result
        try:
            root = self._root(handle.operation_id)
            transport = json.loads((root / "transport.json").read_text())
            recover_owned_containers(root / "docker", docker_host=transport["docker_host"])
        except (ValueError, RuntimeError, OSError):
            return CleanupResult(False, "owned Docker command cleanup is unconfirmed")
        return CleanupResult(True)

    def collect(self, handle: ExecutionHandle) -> Submission:
        if not self.cleanup(handle).complete:
            raise RuntimeError("Docker cleanup required before freezing output")
        return self.process.collect(self._handle(handle))
