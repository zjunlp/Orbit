"""One-worker coordinator: durable intents, shared leases and explicit recovery."""

import json
import shutil
import threading
from collections.abc import Callable
from dataclasses import asdict, replace
from typing import Any

from agent_infra.records import EventDraft, ProducerKind, RecordContext
from agent_infra.records.local import LocalRecordsStore
from agent_infra.resources import LocalResourceManager
from agent_infra.resources.api import ResourceLease, ResourceRequest
from agent_infra.runs.control_api import (
    ControlError,
    PreparedRun,
    SubmissionRequest,
    preparation_identity,
)
from agent_infra.runs.control_store import RunControlStore
from agent_infra.runs.service import LocalRunService


class LocalRunController:
    def __init__(
        self,
        store: RunControlStore,
        service: LocalRunService,
        records: LocalRecordsStore,
        resources: LocalResourceManager,
        prepare: Callable[[SubmissionRequest], PreparedRun],
        refresh: Callable[[], None],
        recover: Callable[[], object],
    ) -> None:
        self.store, self.service, self.records = store, service, records
        self.resources, self.prepare, self.refresh, self.recover = (
            resources,
            prepare,
            refresh,
            recover,
        )
        self._lock = threading.RLock()
        self._cancel = threading.Event()
        self._thread: threading.Thread | None = None
        self._active: str | None = None
        self._companions: set[str] = set()
        self._companion_failed = False
        self.quarantined = False
        self.closed = False
        self.reconcile()

    def reconcile(self) -> None:
        """Must run under the external host lock before accepting any commands."""
        self.quarantined = True
        recovered_containers = self.recover()
        self.resources.reconcile_owned()
        for entry in self.store.unfinished():
            if entry["request"].get("kind") == "command":
                continue  # Durable command supervisors recover through the shared execution kernel.
            run_id = entry["run_id"]
            self._clean_credentials(run_id)
            attempts = self.records.list_attempts(run_id)
            lease_ids = {
                str(event.payload["lease_id"])
                for attempt in attempts
                for event in self.records.read_trace(attempt.manifest.attempt_id).events
                if event.event_type == "lease.granted" and event.payload.get("lease_id")
            }
            if entry.get("lease_id"):
                lease_ids.add(str(entry["lease_id"]))
            for lease_id in lease_ids:
                self.resources.release(lease_id)
            result: dict[str, Any] = {
                "run_id": run_id,
                "attempt_id": entry["attempt_id"],
                "status": "interrupted",
                "cleanup_complete": True,
                "lease_released": bool(lease_ids),
                "lease_id": next(iter(lease_ids), None),
                "resource_namespace_reconciled": True,
                "lease_release_basis": "owned containers absent; old process leases invalidated",
                "evaluation_status": "not_requested",
                "error": "controller restarted; no automatic replay",
            }
            # Preserve an already committed outcome in the Records -> intent commit gap.
            if attempts and attempts[-1].status != "running":
                result = dict(attempts[-1].result or result)
                result.update(
                    cleanup_complete=True,
                    lease_released=bool(lease_ids),
                    recovery_cleanup_complete=True,
                    resource_namespace_reconciled=True,
                )
            for attempt in attempts:
                sink = self.records.scoped_sink(
                    RecordContext(
                        run_id, attempt.manifest.attempt_id, "controller:recovery", ProducerKind.RUN
                    )
                )
                sink.append_events(
                    (
                        EventDraft(
                            "controller.reconciled",
                            {
                                "cleanup_complete": True,
                                "resource_namespace_reconciled": True,
                                "recovery_policy": "interrupt_and_clean",
                                "resumed": False,
                                "containers_removed": list(recovered_containers)
                                if isinstance(recovered_containers, tuple)
                                else [],
                            },
                        ),
                    )
                )
                if attempt.status == "running":
                    sink = self.records.scoped_sink(
                        RecordContext(
                            run_id,
                            attempt.manifest.attempt_id,
                            "controller:recovery",
                            ProducerKind.RUN,
                        )
                    )
                    sink.append_events(
                        (
                            EventDraft(
                                "controller.interrupted",
                                {
                                    "cleanup_complete": True,
                                    "native_stream_coverage": "partial",
                                    "resumed": False,
                                },
                            ),
                        )
                    )
                    self.records.finish_attempt(
                        attempt.manifest.attempt_id, status="interrupted", result=result
                    )
            if attempts:
                self.records.finish_run(run_id, status=str(result["status"]))
            self.store.update(run_id, state="finished", result=result)
        self._companions.clear()
        self._companion_failed = False
        self.quarantined = False

    def preflight(self, request: SubmissionRequest) -> dict[str, Any]:
        with self._lock:
            try:
                prepared = self.prepare(request)
                self.refresh()
                assessment = self.resources.assess(prepared.resources)
                issues = [asdict(item) for item in assessment.shortages]
                if self._active or self.closed or self.quarantined:
                    issues.append({"reason": "controller busy, stopping or quarantined"})
                return {
                    "ready": not issues,
                    "issues": issues,
                    "image_id": prepared.request.resolved_image,
                    "resources": asdict(prepared.resources),
                    "lineage": prepared.lineage,
                }
            except (ValueError, OSError, RuntimeError) as error:
                return {"ready": False, "issues": [{"reason": str(error)}]}

    def submit(
        self,
        operation_id: str,
        request: SubmissionRequest,
        *,
        expected_identity: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not isinstance(operation_id, str) or not 1 <= len(operation_id) <= 128:
            raise ControlError("invalid_request", "operation_id must contain 1–128 characters")
        payload = asdict(request)
        with self._lock:
            existing = self.store.lookup(operation_id, payload)
            if existing is not None:
                return existing
            if self.closed or self.quarantined:
                raise ControlError(
                    "unavailable", "controller stopping or quarantined; restart to reconcile"
                )
            if self._active is not None:
                raise ControlError(
                    "busy", "one Run is already active; no queue, retry after it finishes"
                )
            prepared = self.prepare(request)
            if (
                expected_identity is not None
                and preparation_identity(prepared) != expected_identity
            ):
                raise ControlError("preparation_changed", "authorized execution identity changed")
            self.refresh()
            assessment = self.resources.assess(prepared.resources)
            if assessment.shortages:
                raise ControlError(
                    "resource_unavailable", "; ".join(item.reason for item in assessment.shortages)
                )
            entry = self.store.create(operation_id, payload, prepared.lineage)
            self._active = entry["run_id"]
            self._cancel = threading.Event()
            self._thread = threading.Thread(
                target=self._execute, args=(entry, prepared), name="agent-infra-run", daemon=False
            )
            try:
                self._thread.start()
            except RuntimeError:
                self._active = None
                self.store.update(
                    entry["run_id"],
                    state="finished",
                    result={
                        "status": "failed",
                        "cleanup_complete": True,
                        "lease_released": False,
                        "error": "worker thread could not start",
                    },
                )
                raise
            return entry

    def cancel(self, run_id: str) -> dict[str, Any]:
        with self._lock:
            entry = self.store.get(run_id)
            if entry["request"].get("kind") in {"research", "environment", "planner"}:
                raise ControlError(
                    "research_requires_close",
                    "use the bound research close or environment cancel command",
                )
            if entry["state"] == "finished":
                return entry
            entry = self.store.update(run_id, cancel_requested=True)
            if self._active == run_id:
                self._cancel.set()
            return entry

    def reserve_research(
        self, operation_id: str, payload: dict[str, Any], project_id: str
    ) -> dict[str, Any]:
        """Share the single execution slot with the long-lived research use case."""
        with self._lock:
            if self.closed or self.quarantined or self._active is not None:
                raise ControlError("busy", "controller busy, stopping or quarantined")
            entry = self.store.create(operation_id, payload, {"project_id": project_id})
            self._active = entry["run_id"]
            return entry

    def release_research(self, run_id: str, *, clean: bool) -> None:
        with self._lock:
            if self._active == run_id:
                self._active = None
            self.quarantined = not clean or self._unmanaged_leases()

    def _unmanaged_leases(self) -> bool:
        return self._companion_failed or any(
            lease.lease_id not in self._companions for lease in self.resources.active_leases
        )

    def allocate_companion(self, request: ResourceRequest) -> ResourceLease:
        """Reserve a Planner alongside the single experiment, using the same total quota."""
        with self._lock:
            if self.closed or self.quarantined:
                raise ControlError("unavailable", "controller is stopping or quarantined")
            self.refresh()
            lease = self.resources.try_allocate(request).lease
            if lease is None:
                raise ControlError("resource_unavailable", "insufficient resources for Planner")
            self._companions.add(lease.lease_id)
            return lease

    def release_companion(self, lease_id: str, *, clean: bool) -> None:
        with self._lock:
            if clean:
                self.resources.release(lease_id)
                self._companions.discard(lease_id)
            else:
                self._companions.discard(lease_id)
                self._companion_failed = True
                self.quarantined = True

    def _clean_credentials(self, run_id: str) -> None:
        for path in (
            self.service.state_dir / run_id / "agent-home",
            self.store.path.parent / "credentials" / run_id,
        ):
            if path.exists():
                shutil.rmtree(path)

    def _execute(self, entry: dict[str, Any], prepared: PreparedRun) -> None:
        run_id = entry["run_id"]
        outcome: dict[str, Any]
        try:
            self.store.update(run_id, state="running")
            if self._cancel.is_set():
                outcome = {
                    "status": "cancelled",
                    "cleanup_complete": True,
                    "lease_released": False,
                    "lease_id": None,
                }
            else:
                home = prepared.agent.stage_container_credentials(
                    self.store.path.parent / "credentials" / run_id
                )
                self.refresh()
                result = self.service.run(
                    replace(prepared.request, credential_home=home),
                    prepared.agent,
                    cancellation=self._cancel,
                    run_id=run_id,
                    attempt_id=entry["attempt_id"],
                )
                outcome = json.loads(json.dumps(asdict(result), default=str))
        except Exception as error:
            # Do not reflect credential/provider exception text into public records.
            outcome = {
                "status": "failed",
                "cleanup_complete": False,
                "lease_released": False,
                "error": f"controller worker failed ({type(error).__name__}); restart for cleanup",
            }
        finally:
            try:
                self._clean_credentials(run_id)
            except OSError:
                outcome = {
                    "status": "cleanup_failed",
                    "cleanup_complete": False,
                    "lease_released": False,
                    "error": "credential copy cleanup failed",
                }
        with self._lock:
            self.quarantined = (
                not outcome.get("cleanup_complete", False) or self._unmanaged_leases()
            )
            self.store.update(
                run_id, state="quarantined" if self.quarantined else "finished", result=outcome
            )
            self._active = None

    def close(self) -> bool:
        with self._lock:
            self.closed = True
            self._cancel.set()
        if self._thread is not None:
            self._thread.join(timeout=90)
        return self._active is None and not self.quarantined
