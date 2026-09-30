"""Native benchmark requests adapted to the common durable execution lifecycle."""

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from agent_infra.benchmarks.execution import PreparedExecution, execution_spec, validate_backend
from agent_infra.environments.execution_api import ExecutionBackend
from agent_infra.resources.api import ResourceClaim
from agent_infra.resources.persistent import PersistentLeaseStore
from agent_infra.runs.control_store import RunControlStore
from agent_infra.runs.execution import (
    DurableExecutionService,
    ExecutionDefinition,
    ExecutionRecords,
)


def _prepared(request: dict[str, Any]) -> PreparedExecution:
    return PreparedExecution.model_validate_json(json.dumps(request["execution"]))


def _definition(request: dict[str, Any]) -> ExecutionDefinition:
    execution = _prepared(request)
    plan = execution.frozen_plan.plan
    phase = plan.phases[0]
    return ExecutionDefinition(
        spec=execution_spec(execution, "preview", "preview", Path("/preview")),
        claim=ResourceClaim(
            "preview",
            "preview",
            phase.backend,
            phase.resources.cpu_cores,
            phase.resources.memory_bytes,
            phase.resources.gpu_count,
            phase.resources.allocator,
        ),
        lineage={"benchmark": plan.suite.benchmark, "plan_digest": execution.frozen_plan.digest},
        digest=execution.digest,
        task_digest=execution.frozen_plan.digest,
        planned_wall_seconds=phase.budget.wall_seconds,
        requested_resources=phase.resources.model_dump(mode="json"),
    )


class BenchmarkExecutionService(DurableExecutionService):
    def __init__(
        self,
        store: RunControlStore,
        records: ExecutionRecords,
        backend: ExecutionBackend,
        workspace_root: Path,
        *,
        validate_native: Callable[[PreparedExecution], None] | None = None,
        interpret: Callable[[Path], dict[str, Any]] | None = None,
        leases: PersistentLeaseStore | None = None,
    ) -> None:
        def validate(request: dict[str, Any]) -> None:
            execution = _prepared(request)
            validate_backend(
                execution,
                backend.backend_id,
                backend.features,
                native_runtime=validate_native is not None,
            )
            if validate_native is not None:
                validate_native(execution)

        super().__init__(
            store,
            records,
            backend,
            workspace_root,
            resolve=_definition,
            validate=validate,
            interpret=interpret,
            leases=leases,
        )

    def submit(
        self,
        operation_id: str,
        execution: PreparedExecution,
        *,
        budget_group: str | None = None,
        budget_wall_seconds: float | None = None,
    ) -> dict[str, Any]:
        return self.submit_request(
            operation_id,
            {"kind": "benchmark", "execution": execution.model_dump(mode="json")},
            budget_group=budget_group,
            budget_wall_seconds=budget_wall_seconds,
        )
