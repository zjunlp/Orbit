"""Direct experiments resolve code/image once and reuse durable execution and Records."""

import hashlib
import json
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from agent_infra.environments.api import ProcessCommand
from agent_infra.environments.command_api import CommandExecutionSpec
from agent_infra.environments.execution_api import ExecutionBackend
from agent_infra.environments.workspace import snapshot_workspace
from agent_infra.records.api import ArtifactRef
from agent_infra.resources.api import ResourceClaim
from agent_infra.resources.persistent import PersistentLeaseStore
from agent_infra.runs.command_api import CommandRequest
from agent_infra.runs.control_api import ControlError
from agent_infra.runs.control_store import RunControlStore
from agent_infra.runs.execution import (
    DurableExecutionService,
    ExecutionDefinition,
    ExecutionRecords,
)


def command_definition(payload: dict[str, Any]) -> ExecutionDefinition:
    request = CommandRequest.model_validate(payload["command"])
    code = payload["code"]
    spec = CommandExecutionSpec(
        run_id="preview",
        attempt_id="preview",
        unit_id=request.name,
        phase_id="command",
        workspace="/preview",
        command=ProcessCommand(
            request.argv, cwd=request.cwd, timeout_seconds=request.timeout_seconds
        ),
        outputs=request.outputs,
        image=payload["image_id"],
        snapshot=code["path"],
        snapshot_digest=code["digest"],
        cpu_cores=request.cpu_cores,
        memory_bytes=request.memory_bytes,
        gpu_device_ids=request.gpu_device_ids,
        mounts=request.mounts,
        network=request.network,
        max_artifact_bytes=1024**3,
    )
    return ExecutionDefinition(
        spec,
        ResourceClaim(
            "preview",
            "preview",
            "docker-command-v1",
            request.cpu_cores,
            request.memory_bytes,
            len(request.gpu_device_ids),
            "local",
            request.gpu_device_ids,
        ),
        {
            "project_id": request.project_id,
            "workspace": request.project,
            "name": request.name,
            "session_id": request.session_id,
            "provider": request.provider,
            "parent_run_id": request.parent_run_id,
            "code": code,
        },
        spec.digest(),
        code["digest"],
        request.timeout_seconds,
    )


class CommandRuns:
    def __init__(
        self,
        store: RunControlStore,
        records: ExecutionRecords,
        backend: ExecutionBackend,
        root: Path,
        leases: PersistentLeaseStore,
        image: Callable[[str], str],
        authorize: Callable[[CommandRequest], None],
        project: Callable[[CommandRequest], str] | None = None,
        after_archive: Callable[[ArtifactRef], None] | None = None,
    ) -> None:
        self.root, self.image, self.authorize = root, image, authorize
        self.project = project
        for run in store.unfinished():
            if run["request"].get("kind") == "command" and run.get("lease_id"):
                if (run.get("lease_store"), run.get("lease_scope")) != (
                    str(leases.path.parent),
                    leases.scope,
                ):
                    raise ValueError(
                        "unfinished commands belong to another node ledger; "
                        "restart with the original AGENT_INFRA_NODE_STATE"
                    )
        self.service = DurableExecutionService(
            store,
            records,
            backend,
            root / "workspaces",
            resolve=command_definition,
            leases=leases,
            kind="command",
            after_archive=after_archive,
        )
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def submit(self, operation: str, request: CommandRequest) -> dict[str, Any]:
        if not isinstance(operation, str) or not 1 <= len(operation) <= 128:
            raise ValueError("operation_id must contain 1–128 characters")
        with self._lock:
            if self.project is not None:
                request = request.model_copy(update={"project_id": self.project(request)})
            if self._stop.is_set():
                raise ControlError("unavailable", "command worker is stopping")
            previous = self.service.store.find_operation(operation)
            body = request.model_dump(mode="json")
            if previous is not None:
                if previous["request"].get("command") != body:
                    raise ControlError(
                        "idempotency_conflict", "operation_id has different parameters"
                    )
                return previous
            self.authorize(request)
            image = self.image(request.image)
            root = self.root / "snapshots" / hashlib.sha256(operation.encode()).hexdigest()
            if root.exists():
                # An orphan snapshot may survive a crash before admission; never relabel it.
                metadata = json.loads((root / "evidence/code.json").read_text())
                if metadata.get("request") != body:
                    raise ControlError(
                        "snapshot_conflict", "snapshot exists for a different request"
                    )
                image = metadata["image_id"]
            else:
                metadata = snapshot_workspace(
                    Path(request.project), root, provenance={"request": body, "image_id": image}
                )
            payload = {
                "kind": "command",
                "command": body,
                "image_id": image,
                "code": {
                    "path": str(root / "source"),
                    "digest": metadata["digest"],
                    "commit": metadata["commit"],
                },
            }
            return self.service.submit_request(operation, payload)

    def rerun(self, run_id: str, operation: str) -> dict[str, Any]:
        old = self.service.store.get(run_id)
        if old["request"].get("kind") != "command":
            raise ValueError("rerun supports direct command experiments only")
        request = CommandRequest.model_validate(old["request"]["command"])
        # New code is deliberately snapshotted and differences remain reviewable.
        return self.submit(operation, request.model_copy(update={"parent_run_id": run_id}))

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("command worker already started")
        self._thread = threading.Thread(target=self._watch, name="command-runs", daemon=True)
        self._thread.start()

    def _watch(self) -> None:
        while not self._stop.wait(0.25):
            with self._lock:
                for run in self.service.store.unfinished():
                    if run["request"].get("kind") != "command":
                        continue
                    try:
                        self.service.status(run["run_id"])
                    except Exception as error:
                        self.service.store.update(
                            run["run_id"], detail=f"reconcile failed: {type(error).__name__}"
                        )

    def close(self) -> None:
        # Supervisors continue on daemon exit; restart observes the same durable identity.
        self._stop.set()
        if self._thread is not None:
            self._thread.join(30)
            if self._thread.is_alive():
                raise RuntimeError("command observer did not stop")
