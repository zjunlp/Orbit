"""FIFO-admitted execution using durable leases and Records.

There are no benchmark-specific branches or scoring rules here. A lease is held until cleanup
and evidence collection both succeed.
"""

import math
from collections.abc import Callable
from dataclasses import asdict, dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

from agent_infra.environments.execution_api import ExecutionBackend, ExecutionHandle, ExecutionSpec
from agent_infra.records.api import (
    AttemptManifest,
    CaptureStatus,
    DataClass,
    EventDraft,
    ProducerKind,
    RecordContext,
    RecordSink,
    RecordsReader,
    RecordsWriter,
    RunManifest,
    Visibility,
)
from agent_infra.resources.api import AllocationStatus, ResourceClaim
from agent_infra.resources.persistent import PersistentLeaseStore
from agent_infra.runs.benchmark_budget import budget_view
from agent_infra.runs.control_store import RunControlStore


class ExecutionRecords(RecordsWriter, RecordsReader, Protocol):
    pass


@dataclass(frozen=True)
class ExecutionDefinition:
    """Resolved execution facts; protocols keep their own durable request format."""

    spec: ExecutionSpec
    claim: ResourceClaim
    lineage: dict[str, Any]
    digest: str
    task_digest: str
    planned_wall_seconds: float | None
    requested_resources: dict[str, Any] | None = None


class DurableExecutionService:
    def __init__(
        self,
        store: RunControlStore,
        records: ExecutionRecords,
        backend: ExecutionBackend,
        workspace_root: Path,
        *,
        resolve: Callable[[dict[str, Any]], ExecutionDefinition],
        validate: Callable[[dict[str, Any]], None] | None = None,
        kind: str = "benchmark",
        interpret: Callable[[Path], dict[str, Any]] | None = None,
        leases: PersistentLeaseStore | None = None,
    ) -> None:
        self.resolve, self.validate, self.interpret = resolve, validate, interpret
        self.kind = kind
        self.visibility = Visibility.ADMIN if kind == "benchmark" else Visibility.USER
        self.store, self.records, self.backend, self.workspace_root = (
            store,
            records,
            backend,
            workspace_root,
        )
        self.leases = leases or PersistentLeaseStore(store.path.parent / "leases")

    def submit_request(
        self,
        operation_id: str,
        request: dict[str, Any],
        *,
        budget_group: str | None = None,
        budget_wall_seconds: float | None = None,
    ) -> dict[str, Any]:
        if not operation_id or len(operation_id) > 128:
            raise ValueError("operation_id must contain 1–128 characters")
        if (budget_group is None) != (budget_wall_seconds is None):
            raise ValueError("budget group and wall limit must be supplied together")
        if budget_group is not None and (not budget_group.strip() or len(budget_group) > 128):
            raise ValueError("budget group must contain 1–128 characters")
        if budget_wall_seconds is not None and (
            not math.isfinite(budget_wall_seconds) or budget_wall_seconds <= 0
        ):
            raise ValueError("budget wall limit must be positive and finite")
        if request.get("kind") != self.kind:
            raise ValueError("execution request belongs to a different service")
        if self.validate is not None:
            self.validate(request)
        execution = self.resolve(request)
        payload = dict(request)
        if budget_group is not None:
            payload.update(budget_group=budget_group, budget_wall_seconds=budget_wall_seconds)
        with self.store.exclusive():
            if budget_group is not None:
                for existing in self.store.ordered():
                    request = existing["request"]
                    if (
                        request.get("budget_group") == budget_group
                        and float(request["budget_wall_seconds"]) != budget_wall_seconds
                    ):
                        raise ValueError("budget group has conflicting limits")
            run = self.store.lookup(operation_id, payload)
            if run is None:
                run = self.store.create(
                    operation_id,
                    payload,
                    execution.lineage,
                    initial_state="queued",
                    launch_authorized=True,
                )
            return self._advance(run, allow_submit=True)

    def status(self, run_id: str, *, cancel: bool = False) -> dict[str, Any]:
        with self.store.exclusive():
            run = self.store.get(run_id)
            if run["request"].get("kind") != self.kind:
                raise KeyError(run_id)
            if cancel and run["state"] != "finished":
                run = self.store.update(run_id, cancel_requested=True)
            return self._advance(run)

    def reconcile(self) -> list[dict[str, Any]]:
        # Recovery observes existing intents only, never automatically resubmits.
        return [
            self.status(run["run_id"])
            for run in self.store.unfinished()
            if run["request"].get("kind") == self.kind
        ]

    def _sink(self, run: dict[str, Any], execution: ExecutionDefinition) -> RecordSink:
        timestamp = datetime.fromisoformat(run["created_at"])
        self.records.begin_run(
            RunManifest(
                run["run_id"],
                timestamp,
                {
                    "kind": self.kind,
                    "execution_digest": execution.digest,
                    **run["lineage"],
                },
            )
        )
        manifest = AttemptManifest(
            run["attempt_id"],
            run["run_id"],
            timestamp,
            task_id=execution.spec.unit_id,
            task_digest=execution.task_digest,
            coverage={
                "agent_native": (
                    "native_bundle"
                    if "native_evidence" in self.backend.features
                    else "not_instrumented"
                ),
                "process_output": "bounded_raw",
                "resources": (
                    "native_attestation"
                    if "cpu_memory_limits" in self.backend.features
                    else "durable_admission_lease"
                    if run.get("lease_id")
                    else "not_allocated"
                ),
                "cleanup": "backend_scope",
            },
        )
        try:
            previous = self.records.get_attempt(run["attempt_id"]).manifest
        except KeyError:
            pass
        else:
            # Capture declarations are frozen at first admission, including older runtimes.
            manifest = replace(manifest, coverage=previous.coverage)
        self.records.begin_attempt(manifest)
        sink = self.records.scoped_sink(
            RecordContext(
                run["run_id"],
                run["attempt_id"],
                self.kind + ":" + run["attempt_id"],
                ProducerKind.RUN,
                phase_id=execution.spec.phase_id,
            )
        )
        sink.start_stream(
            run["attempt_id"] + ":combined",
            "native/combined",
            visibility=self.visibility,
            data_class=DataClass.USER_PRIVATE,
        )
        return sink

    def _event(self, sink: RecordSink, name: str, payload: dict[str, Any]) -> None:
        sequence = (
            "execution.requested",
            "execution.started",
            "execution.finished",
            "execution.cleanup_confirmed",
            "execution.slot_released",
        ).index(name)
        sink.append_events(
            (
                EventDraft(
                    name,
                    payload,
                    producer_sequence=sequence,
                    idempotency_key=f"{sink.context.producer_id}:{name}",
                    visibility=self.visibility,
                ),
            )
        )

    @staticmethod
    def _claim(run: dict[str, Any], execution: ExecutionDefinition) -> ResourceClaim:
        return replace(execution.claim, request_id=run["attempt_id"], owner_id=run["run_id"])

    @staticmethod
    def _shortages(decision: Any) -> list[dict[str, Any]]:
        return [asdict(item) for item in decision.shortages]

    @staticmethod
    def _accounting(run: dict[str, Any], execution: ExecutionDefinition) -> dict[str, Any]:
        requested = {
            key: value
            for key, value in asdict(execution.claim).items()
            if key not in {"request_id", "owner_id", "backend"}
        }
        if execution.requested_resources is not None:
            requested = execution.requested_resources
        return {
            "requested": requested,
            "authorized": requested if run.get("lease_id") else None,
            "lease_id": run.get("lease_id"),
            "actual_allocation": run.get("allocation"),
            "actual_allocation_status": "attested" if run.get("allocation") else "not_attested",
            "usage": run.get("usage"),
        }

    def _release_lease(self, run: dict[str, Any]) -> None:
        lease_id = run.get("lease_id")
        epoch = run.get("lease_owner_epoch")
        if lease_id is not None and epoch is not None:
            self.leases.release(lease_id, epoch, cleanup_confirmed=True)

    def _mark_reconciling(self, run: dict[str, Any], reason: str) -> None:
        lease_id = run.get("lease_id")
        epoch = run.get("lease_owner_epoch")
        if lease_id is not None and epoch is not None:
            self.leases.reconcile(lease_id, epoch, reason)

    def _advance(self, run: dict[str, Any], *, allow_submit: bool = False) -> dict[str, Any]:
        if run["state"] == "finished":
            return run
        execution = self.resolve(run["request"])
        if run["state"] == "queued":
            if run["cancel_requested"]:
                return self._finish(
                    run,
                    self._sink(run, execution),
                    "cancelled",
                    None,
                    None,
                    False,
                    (),
                    "never_launched",
                )
            budget = budget_view(run, self.store.ordered())
            if budget is not None and not budget["admissible"]:
                return self._finish(
                    run,
                    self._sink(run, execution),
                    "failed",
                    None,
                    None,
                    False,
                    (),
                    "never_launched",
                    {
                        "evaluation": "not_applicable",
                        "protocol": "valid",
                        "reason": "budget group wall-time limit exhausted",
                        "budget": budget,
                    },
                )
            position = self.store.queue_position(run["run_id"])
            if position != 1:
                return self.store.update(
                    run["run_id"],
                    state="queued",
                    slot_held=False,
                    queue_position=position,
                    detail="waiting for earlier FIFO submissions",
                )
            decision = self.leases.acquire(self._claim(run, execution))
            if decision.status is AllocationStatus.WAITING:
                return self.store.update(
                    run["run_id"],
                    state="queued",
                    slot_held=False,
                    queue_position=position,
                    shortages=self._shortages(decision),
                    detail="waiting for durable resource lease",
                )
            if decision.status is AllocationStatus.UNSATISFIABLE:
                return self._finish(
                    run,
                    self._sink(run, execution),
                    "failed",
                    None,
                    None,
                    False,
                    (),
                    "never_launched",
                    {
                        "evaluation": "not_applicable",
                        "protocol": "valid",
                        "reason": "resource request exceeds scheduler capacity",
                        "shortages": self._shortages(decision),
                    },
                )
            assert decision.lease is not None
            run = self.store.update(
                run["run_id"],
                state="accepted",
                slot_held=True,
                queue_position=None,
                shortages=[],
                lease_id=decision.lease.lease_id,
                lease_owner_epoch=decision.lease.owner_epoch,
                lease_state=decision.lease.state.value,
                detail=None,
            )
            allow_submit = True
        sink = self._sink(run, execution)
        # Records may have committed before the control-store completion acknowledgement.
        attempt = self.records.get_attempt(run["attempt_id"])
        if attempt.status != "running":
            self.records.finish_run(run["run_id"], status=attempt.status)
            if (attempt.result or {}).get("cleanup_complete"):
                self._release_lease(run)
                self._event(sink, "execution.slot_released", {"cleanup_confirmed": True})
            return self.store.update(
                run["run_id"],
                state="finished",
                slot_held=False,
                lease_state="released" if run.get("lease_id") else None,
                result=dict(attempt.result or {}),
            )
        backend_operation = run["attempt_id"]
        spec = execution.spec.model_copy(
            update={
                "run_id": run["run_id"],
                "attempt_id": run["attempt_id"],
                "workspace": str((self.workspace_root / run["run_id"]).absolute()),
            }
        )
        self._event(
            sink,
            "execution.requested",
            {"operation_id": run["operation_id"], "spec_digest": spec.digest()},
        )
        receipt = self.backend.reconcile(backend_operation)
        if receipt.state == "not_submitted":
            if run["cancel_requested"]:
                return self._finish(run, sink, "cancelled", None, None, False, (), "never_launched")
            if not allow_submit and not (
                run.get("launch_authorized") is True and run.get("lease_id")
            ):
                return self.store.update(
                    run["run_id"],
                    state="accepted",
                    slot_held=True,
                    detail="not submitted; replay the same explicit operation to launch",
                )
            self.store.update(run["run_id"], state="submitting", slot_held=True)
            try:
                self.backend.submit(backend_operation, spec)
            except Exception as error:
                # The reply can be lost after launch. Persist uncertainty; never retry here.
                self._mark_reconciling(run, f"submit unconfirmed: {type(error).__name__}")
                return self.store.update(
                    run["run_id"],
                    state="quarantined",
                    slot_held=True,
                    detail=f"submit unconfirmed: {type(error).__name__}",
                )
            receipt = self.backend.reconcile(backend_operation)
        handle = receipt.handle
        if handle is None:
            self._mark_reconciling(run, receipt.reason or "backend identity unavailable")
            return self.store.update(
                run["run_id"],
                state="quarantined",
                slot_held=True,
                detail=receipt.reason or "backend identity unavailable",
            )
        if handle.spec_digest != spec.digest():
            raise ValueError("reconciled operation belongs to a different execution spec")
        run = self.store.update(run["run_id"], handle=asdict(handle), slot_held=True)
        if handle.native_id:
            lease_id = run.get("lease_id")
            epoch = run.get("lease_owner_epoch")
            if lease_id is not None and epoch is not None:
                lease = self.leases.bind_native(
                    lease_id,
                    epoch,
                    backend=self._claim(run, execution).backend,
                    native_id=handle.native_id,
                )
                run = self.store.update(run["run_id"], lease_state=lease.state.value)
            self._event(
                sink,
                "execution.started",
                {"native_id": handle.native_id, "backend": handle.backend},
            )
        if run["cancel_requested"]:
            self.backend.cancel(handle)
        cursor = run.get("cursor", 0)
        while True:
            observation = self.backend.observe(handle, cursor)
            if observation.allocation is not None:
                attested = asdict(observation.allocation)
                if attested != run.get("allocation"):
                    run = self.store.update(run["run_id"], allocation=attested)
            if observation.usage is not None:
                measured = asdict(observation.usage)
                if measured != run.get("usage"):
                    run = self.store.update(run["run_id"], usage=measured)
            if observation.data:
                sink.append_stream(run["attempt_id"] + ":combined", observation.data, cursor)
                cursor = observation.next_cursor
                run = self.store.update(run["run_id"], cursor=cursor)
            if observation.eof or not observation.data:
                break
        if observation.status in {"running", "unknown"}:
            if observation.status == "unknown":
                self._mark_reconciling(run, receipt.reason or "native execution unknown")
            return self.store.update(
                run["run_id"],
                state="running" if observation.status == "running" else "quarantined",
                detail=receipt.reason,
                slot_held=True,
            )
        cleanup = self.backend.cleanup(handle)
        if not cleanup.complete:
            self._mark_reconciling(run, cleanup.reason or "cleanup unconfirmed")
            return self.store.update(
                run["run_id"], state="quarantined", slot_held=True, detail=cleanup.reason
            )
        return self._collect(
            run, sink, handle, observation.status, observation.exit_code, observation.logs_truncated
        )

    def _collect(
        self,
        run: dict[str, Any],
        sink: RecordSink,
        handle: ExecutionHandle,
        status: str,
        exit_code: int | None,
        truncated: bool,
    ) -> dict[str, Any]:
        try:
            submission = self.backend.collect(handle)
            artifacts = [
                item
                for item in self.records.list_artifacts(run["attempt_id"])
                if item.name == "native-submission" and item.digest == submission.digest
            ]
            artifact = (
                artifacts[0]
                if artifacts
                else sink.commit_artifact(
                    submission.root, name="native-submission", visibility=self.visibility
                )
            )
            return self._finish(
                run,
                sink,
                status,
                exit_code,
                artifact.artifact_id,
                truncated,
                submission.missing,
                self.backend.cleanup_scope,
                self.interpret(submission.root) if self.interpret else None,
            )
        except (OSError, ValueError, RuntimeError) as error:
            # Keep the source spool and slot; a later status/reconcile retries collection only.
            return self.store.update(
                run["run_id"],
                state="collecting",
                slot_held=True,
                detail=f"evidence collection failed: {type(error).__name__}",
            )

    def _finish(
        self,
        run: dict[str, Any],
        sink: RecordSink,
        status: str,
        exit_code: int | None,
        artifact_id: str | None,
        truncated: bool,
        missing: tuple[str, ...],
        scope: str,
        native_result: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        capture = CaptureStatus.TRUNCATED if truncated else CaptureStatus.COMPLETE
        stream = sink.finalize_stream(run["attempt_id"] + ":combined", capture)
        result = {
            "execution": status,
            "exit_code": exit_code,
            "evaluation": "not_interpreted" if self.kind == "benchmark" else "not_requested",
            "protocol": "not_validated" if self.kind == "benchmark" else "not_applicable",
            "cleanup_complete": True,
            "cleanup_scope": scope,
            "capture": "partial" if missing else capture.value,
            "missing_outputs": list(missing),
            "artifact_id": artifact_id,
            "stream": asdict(stream),
        }
        execution = self.resolve(run["request"])
        result["resource_accounting"] = self._accounting(run, execution)
        result["budget"] = {
            "planned_wall_seconds": execution.planned_wall_seconds,
            "measured_elapsed_seconds": (run.get("usage") or {}).get("elapsed_seconds"),
            "group": budget_view(run, self.store.ordered()),
        }
        if native_result is not None:
            result["native_result"] = native_result
            result["evaluation"] = native_result.get("evaluation", "unknown")
            result["protocol"] = native_result.get("protocol", "unknown")
        self._event(sink, "execution.finished", result)
        self._event(sink, "execution.cleanup_confirmed", {"scope": scope})
        self.records.finish_attempt(run["attempt_id"], status=status, result=result)
        self.records.finish_run(run["run_id"], status=status)
        # Release only after both durable evidence and a positive cleanup receipt.
        self._release_lease(run)
        self._event(sink, "execution.slot_released", {"cleanup_confirmed": True})
        return self.store.update(
            run["run_id"],
            state="finished",
            slot_held=False,
            lease_state="released" if run.get("lease_id") else None,
            result=result,
            detail=None,
        )
