"""Compose native runtimes with shared local admission and separate external domains."""

import argparse
import json
import math
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any, cast

from agent_infra.benchmarks.api import CapabilityProfile
from agent_infra.benchmarks.campaign_api import CampaignPolicy
from agent_infra.benchmarks.execution import (
    PreparedExecution,
    execution_spec,
    prepare_execution,
    read_execution,
    validate_backend,
    write_execution,
)
from agent_infra.benchmarks.execution_api import NativeRuntimeAdapter
from agent_infra.benchmarks.planning import check_plan, read_plan
from agent_infra.benchmarks.registry import AdapterRegistry
from agent_infra.bootstrap.benchmark_delivery import benchmark_delivery_action
from agent_infra.bootstrap.node_resources import node_leases
from agent_infra.bootstrap.paths import state_root
from agent_infra.environments.execution_api import ExecutionBackend
from agent_infra.environments.managed_process import ManagedProcessBackend
from agent_infra.projects.benchmark_campaign import BenchmarkCampaignService, BenchmarkCampaignStore
from agent_infra.records.api import EventQuery
from agent_infra.records.local import LocalRecordsStore
from agent_infra.resources.api import LeaseCapacity
from agent_infra.resources.persistent import PersistentLeaseStore
from agent_infra.runs.benchmark_budget import budget_view
from agent_infra.runs.benchmark_execution import BenchmarkExecutionService
from agent_infra.runs.control_store import RunControlStore


def _validate_submission(
    prepared: PreparedExecution, args: argparse.Namespace, registry: AdapterRegistry
) -> None:
    is_host = prepared.frozen_plan.plan.phases[0].backend == ManagedProcessBackend.backend_id
    if is_host and not args.allow_host_process:
        raise ValueError("host execution requires --allow-host-process")
    if not is_host and not args.allow_native_runtime:
        raise ValueError("native execution requires --allow-native-runtime")
    loaded = registry.load_identity(prepared.frozen_plan.adapter)
    if prepare_execution(prepared.frozen_plan, loaded) != prepared:
        raise ValueError("adapter invocation changed since execution was prepared")
    profile = CapabilityProfile.model_validate_json(args.capabilities.read_bytes())
    issues = check_plan(prepared.frozen_plan, loaded, profile)
    errors = [issue.message for issue in issues if issue.severity == "error"]
    if errors:
        raise ValueError("incompatible declarations: " + "; ".join(errors))


def execution_action(args: argparse.Namespace, registry: AdapterRegistry) -> dict[str, Any]:
    action = args.benchmark_command
    if action == "prepare":
        frozen = read_plan(args.plan)
        if args.output.resolve().is_relative_to(Path(frozen.source.path).resolve()):
            raise ValueError("execution output must be outside the immutable source")
        execution = prepare_execution(frozen, registry.load_identity(frozen.adapter))
        # Validate the same spec schema that the backend will consume, before presenting it.
        execution_spec(execution, "preview-run", "preview-attempt", Path("/preview-workspace"))
        write_execution(execution, args.output)
        return {
            "output": str(args.output),
            "digest": execution.digest,
            "invocation": execution.invocation.model_dump(mode="json"),
            "runtime_ready": False,
            "next": "review resources; use --allow-host-process or --allow-native-runtime",
        }
    prepared = None
    if action == "run":
        if not args.allow_host_process and not getattr(args, "allow_native_runtime", False):
            raise ValueError(
                "review execution and pass --allow-host-process or --allow-native-runtime"
            )
        prepared = read_execution(args.execution)
        _validate_submission(prepared, args, registry)
    root = state_root(args.state_dir) / "benchmarks"
    if action in {"handoff", "compatibility"}:
        return benchmark_delivery_action(args, registry, root)
    store = RunControlStore(root)
    records = LocalRecordsStore(root / "records")
    leases = PersistentLeaseStore(root / "leases")

    if action == "capacity":
        declared = json.loads(args.file.read_text(encoding="utf-8"))
        if not isinstance(declared, dict) or set(declared) - {
            "max_concurrent",
            "cpu_cores",
            "memory_bytes",
            "gpu_count",
        }:
            raise ValueError("capacity file has unsupported fields")
        capacity = LeaseCapacity(**declared)
        shared = node_leases(root)
        if any(item.state.value != "released" for item in leases.list() + shared.list()):
            raise ValueError("drain and reconcile this benchmark scope before capacity change")
        shared.configure(capacity)
        return {"capacity": asdict(leases.configure(capacity))}

    if action == "queue":

        def lease_document(value: Any) -> dict[str, Any]:
            document = asdict(value)
            document["state"] = value.state.value
            document["created_at"] = value.created_at.isoformat()
            document["updated_at"] = value.updated_at.isoformat()
            return document

        ordered = store.ordered()
        return {
            "capacity": asdict(leases.capacity),
            "queued": [
                {
                    **{key: value for key, value in item.items() if key != "request"},
                    "budget": budget_view(item, ordered),
                }
                for item in store.queued()
            ],
            "leases": [lease_document(item) for item in leases.list() + node_leases(root).list()],
            "admission": "node-shared local leases; separate external/legacy domain",
        }

    def service_for(
        execution: PreparedExecution, run: dict[str, Any] | None = None
    ) -> BenchmarkExecutionService:
        active_legacy = any(
            item.state.value != "released" and item.claim.allocator != "external"
            for item in leases.list()
        )
        local = execution.frozen_plan.plan.phases[0].resources.allocator != "external"
        # Existing active queues must finish with the ledger that granted their leases.
        # Do not change the accounting domain of an in-flight native job.
        if run and run.get("lease_id"):
            execution_leases = PersistentLeaseStore(
                Path(run.get("lease_store", str(root / "leases"))), scope=run.get("lease_scope", "")
            )
        elif local:
            if active_legacy:
                raise ValueError("finish or cancel legacy leases before admitting new local jobs")
            execution_leases = node_leases(root, leases.capacity)
        else:
            execution_leases = leases
        backend: ExecutionBackend
        if execution.frozen_plan.plan.phases[0].backend == ManagedProcessBackend.backend_id:
            if action == "run" and not args.allow_host_process:
                raise ValueError("review the command and pass --allow-host-process")
            backend = ManagedProcessBackend(root / "native")
            validate_backend(execution, backend.backend_id, backend.features)
            return BenchmarkExecutionService(
                store, records, backend, root / "workspaces", leases=execution_leases
            )
        if action == "run" and not args.allow_native_runtime:
            raise ValueError("review native containers/resources and pass --allow-native-runtime")
        runtime = cast(
            NativeRuntimeAdapter,
            registry.load_identity(execution.frozen_plan.adapter).implementation,
        )
        if not all(
            callable(getattr(runtime, name, None))
            for name in ("execution_backend", "validate_execution", "interpret")
        ):
            raise ValueError("adapter does not provide the native runtime extension")
        backend = runtime.execution_backend(root / "native")

        def validate(value: PreparedExecution) -> None:
            runtime.validate_execution(value.frozen_plan.plan, value.invocation)

        return BenchmarkExecutionService(
            store,
            records,
            backend,
            root / "workspaces",
            validate_native=validate,
            interpret=runtime.interpret,
            leases=execution_leases,
        )

    def existing(run: dict[str, Any]) -> BenchmarkExecutionService:
        return service_for(
            PreparedExecution.model_validate_json(json.dumps(run["request"]["execution"])), run
        )

    if action == "campaign":
        campaign = BenchmarkCampaignService(BenchmarkCampaignStore(root / "campaigns"))
        operation = args.campaign_command
        if operation == "create":
            policy = CampaignPolicy.model_validate_json(args.policy.read_bytes())
            if policy.campaign_id != args.campaign_id:
                raise ValueError("campaign ID must match policy file")
            return campaign.create(policy, read_execution(args.execution))
        if operation == "propose":
            return campaign.propose(args.campaign_id, args.parent, read_execution(args.execution))
        if operation == "submit":

            def submit_candidate(
                value: PreparedExecution, operation_id: str, group: str, limit: float
            ) -> dict[str, Any]:
                _validate_submission(value, args, registry)
                return service_for(value).submit(
                    operation_id, value, budget_group=group, budget_wall_seconds=limit
                )

            return campaign.submit(args.campaign_id, args.candidate_id, submit_candidate)
        if operation == "status":
            return campaign.refresh(
                args.campaign_id, lambda run_id: existing(store.get(run_id)).status(run_id)
            )
        return campaign.stop(args.campaign_id)

    if action == "run":
        assert prepared is not None
        run = service_for(prepared).submit(
            args.operation_id,
            prepared,
            budget_group=args.budget_group,
            budget_wall_seconds=args.budget_wall_seconds,
        )
        return {key: value for key, value in run.items() if key != "request"}

    def advance_pending() -> list[dict[str, Any]]:
        return [
            {key: value for key, value in run.items() if key != "request"}
            for pending in store.unfinished()
            for run in [existing(pending).status(pending["run_id"])]
        ]

    if action == "reconcile":
        return {"runs": advance_pending()}
    if action == "worker":
        if not math.isfinite(args.poll_seconds) or not 0.1 <= args.poll_seconds <= 60:
            raise ValueError("worker poll interval must be 0.1–60 seconds")
        if args.max_seconds is not None and (
            not math.isfinite(args.max_seconds) or not 0 < args.max_seconds <= 604800
        ):
            raise ValueError("worker max seconds must be positive and within seven days")
        deadline = time.monotonic() + args.max_seconds if args.max_seconds else None
        completed = 0
        try:
            while True:
                completed += sum(item["state"] == "finished" for item in advance_pending())
                pending = len(store.unfinished())
                if (args.until_empty and not pending) or (
                    deadline is not None and time.monotonic() >= deadline
                ):
                    return {"pending": pending, "completed_observations": completed}
                time.sleep(args.poll_seconds)
        except KeyboardInterrupt:
            return {"pending": len(store.unfinished()), "completed_observations": completed}
    run = existing(store.get(args.run_id)).status(args.run_id, cancel=action == "cancel")
    if action == "events":
        page = records.read_events(EventQuery(run_id=args.run_id, limit=200), args.cursor)
        return {"items": [asdict(item) for item in page.items], "next_cursor": page.next_cursor}
    if action == "artifacts":
        return {"items": [asdict(item) for item in records.list_artifacts(run["attempt_id"])]}
    # Do not print the administrative frozen plan or complete command on every status poll.
    return {key: value for key, value in run.items() if key != "request"}
