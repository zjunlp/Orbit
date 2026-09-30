"""Concurrency-safe single-node resource admission and leases."""

from __future__ import annotations

import threading
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from agent_infra.resources.api import (
    AllocationDecision,
    AllocationStatus,
    GpuCapacity,
    HostResourceSnapshot,
    NodeCapacity,
    PersistentLeaseState,
    ResourceAssessment,
    ResourceClaim,
    ResourceLease,
    ResourceRequest,
    ResourceShortage,
)
from agent_infra.resources.persistent import PersistentLeaseStore

Clock = Callable[[], datetime]
IdFactory = Callable[[], str]


class LocalResourceManager:
    """All-or-nothing admission against authorized capacity and a fresh snapshot."""

    def __init__(
        self,
        capacity: NodeCapacity,
        *,
        snapshot_max_age: timedelta = timedelta(seconds=15),
        clock: Clock = lambda: datetime.now(UTC),
        id_factory: IdFactory = lambda: str(uuid.uuid4()),
        persistent: PersistentLeaseStore | None = None,
        owner_namespace: str = "controller",
    ) -> None:
        if snapshot_max_age.total_seconds() <= 0:
            raise ValueError("snapshot_max_age must be positive")
        self._capacity = capacity
        self._snapshot_max_age = snapshot_max_age
        self._clock = clock
        self._id_factory = id_factory
        self.persistent, self.owner_namespace = persistent, owner_namespace
        self._snapshot: HostResourceSnapshot | None = None
        self._leases: dict[str, ResourceLease] = {}
        self._request_leases: dict[str, str] = {}
        self._requests: dict[str, ResourceRequest] = {}
        self._lock = threading.Lock()

    def update_snapshot(self, snapshot: HostResourceSnapshot) -> None:
        if snapshot.node_id != self._capacity.node_id:
            raise ValueError("snapshot node does not match authorized capacity")
        if self._capacity.cpu_cores > snapshot.cpu_logical_cores:
            raise ValueError("authorized CPU exceeds discovered hardware")
        if self._capacity.memory_bytes > snapshot.memory_total_bytes:
            raise ValueError("authorized memory exceeds discovered hardware")
        with self._lock:
            self._snapshot = snapshot

    def try_allocate(self, request: ResourceRequest) -> AllocationDecision:
        with self._lock:
            existing_id = self._request_leases.get(request.request_id)
            if existing_id is not None:
                if self._requests[request.request_id] != request:
                    raise ValueError("request_id already belongs to a different resource request")
                return AllocationDecision(AllocationStatus.GRANTED, self._leases[existing_id])

            impossible = self._capacity_shortages(request)
            if impossible:
                return AllocationDecision(AllocationStatus.UNSATISFIABLE, shortages=impossible)

            snapshot = self._fresh_snapshot()
            if snapshot is None:
                return AllocationDecision(
                    AllocationStatus.WAITING,
                    shortages=(
                        ResourceShortage(
                            "telemetry",
                            "fresh snapshot",
                            "missing or stale",
                            "allocation waits until the node reports fresh resources",
                        ),
                    ),
                )

            temporary, gpu_ids = self._temporary_shortages(request, snapshot)
            if temporary:
                return AllocationDecision(AllocationStatus.WAITING, shortages=temporary)

            lease = ResourceLease(
                lease_id=self._id_factory(),
                request_id=request.request_id,
                node_id=self._capacity.node_id,
                cpu_cores=request.cpu_cores,
                memory_bytes=request.memory_bytes,
                gpu_device_ids=gpu_ids,
                created_at=self._clock(),
            )
            if self.persistent is not None:
                identity = self.owner_namespace + ":" + request.request_id
                decision = self.persistent.acquire(
                    ResourceClaim(
                        identity,
                        identity,
                        "controller-docker",
                        request.cpu_cores,
                        request.memory_bytes,
                        len(gpu_ids),
                        "local",
                        gpu_ids,
                    )
                )
                if decision.lease is None:
                    return AllocationDecision(decision.status, shortages=decision.shortages)
                if decision.lease.state == PersistentLeaseState.RELEASED:
                    raise ValueError("request already completed; use a new request identity")
                lease = ResourceLease(
                    decision.lease.lease_id,
                    request.request_id,
                    self._capacity.node_id,
                    request.cpu_cores,
                    request.memory_bytes,
                    gpu_ids,
                    decision.lease.created_at,
                )
            if lease.lease_id in self._leases:
                raise RuntimeError("lease ID factory returned a duplicate")
            self._leases[lease.lease_id] = lease
            self._request_leases[request.request_id] = lease.lease_id
            self._requests[request.request_id] = request
            return AllocationDecision(AllocationStatus.GRANTED, lease=lease)

    def assess(self, request: ResourceRequest) -> ResourceAssessment:
        """Admission preview only; never creates a lease or reserves capacity."""
        with self._lock:
            impossible = self._capacity_shortages(request)
            if impossible:
                return ResourceAssessment(AllocationStatus.UNSATISFIABLE, shortages=impossible)
            snapshot = self._fresh_snapshot()
            if snapshot is None:
                return ResourceAssessment(
                    AllocationStatus.WAITING,
                    shortages=(
                        ResourceShortage(
                            "telemetry",
                            "fresh snapshot",
                            "missing or stale",
                            "refresh host telemetry before submitting",
                        ),
                    ),
                )
            shortages, _ = self._temporary_shortages(request, snapshot)
            return ResourceAssessment(
                AllocationStatus.WAITING if shortages else AllocationStatus.GRANTED,
                shortages=shortages,
            )

    def release(self, lease_id: str) -> bool:
        with self._lock:
            if self.persistent is not None:
                try:
                    persistent = self.persistent.get(lease_id)
                except KeyError:
                    return False
                if not persistent.claim.owner_id.startswith(self.owner_namespace + ":"):
                    raise ValueError("lease belongs to another controller")
                self.persistent.release(lease_id, persistent.owner_epoch, cleanup_confirmed=True)
            lease = self._leases.pop(lease_id, None)
            if lease is None:
                return False
            self._request_leases.pop(lease.request_id, None)
            self._requests.pop(lease.request_id, None)
            return True

    @property
    def active_leases(self) -> tuple[ResourceLease, ...]:
        with self._lock:
            return tuple(self._leases.values())

    def reconcile_owned(self) -> None:
        """Only after the caller confirms this controller's containers are absent."""
        if self.persistent is not None:
            for lease in self.persistent.list():
                if lease.claim.owner_id.startswith(self.owner_namespace + ":"):
                    self.persistent.release(
                        lease.lease_id, lease.owner_epoch, cleanup_confirmed=True
                    )

    def _fresh_snapshot(self) -> HostResourceSnapshot | None:
        if self._snapshot is None:
            return None
        age = self._clock() - self._snapshot.captured_at
        if age < timedelta(0) or age > self._snapshot_max_age:
            return None
        return self._snapshot

    def _capacity_shortages(self, request: ResourceRequest) -> tuple[ResourceShortage, ...]:
        shortages: list[ResourceShortage] = []
        required_labels = request.labels_dict()
        actual_labels = self._capacity.labels_dict()
        missing_labels = {
            key: value for key, value in required_labels.items() if actual_labels.get(key) != value
        }
        if missing_labels:
            shortages.append(
                ResourceShortage(
                    "node_labels",
                    str(missing_labels),
                    str(actual_labels),
                    "node does not satisfy placement labels",
                )
            )
        if request.cpu_cores > self._capacity.cpu_cores:
            shortages.append(
                ResourceShortage(
                    "cpu_cores",
                    request.cpu_cores,
                    self._capacity.cpu_cores,
                    "request exceeds authorized node capacity",
                )
            )
        if request.memory_bytes > self._capacity.memory_bytes:
            shortages.append(
                ResourceShortage(
                    "memory_bytes",
                    request.memory_bytes,
                    self._capacity.memory_bytes,
                    "request exceeds authorized node capacity",
                )
            )
        eligible = self._eligible_capacity_gpus(request)
        if len(eligible) < request.gpu.count:
            shortages.append(
                ResourceShortage(
                    "gpus",
                    request.gpu.count,
                    len(eligible),
                    "request cannot fit the authorized GPU inventory",
                )
            )
        return tuple(shortages)

    def _temporary_shortages(
        self, request: ResourceRequest, snapshot: HostResourceSnapshot
    ) -> tuple[tuple[ResourceShortage, ...], tuple[str, ...]]:
        used_cpu = sum(lease.cpu_cores for lease in self._leases.values())
        used_memory = sum(lease.memory_bytes for lease in self._leases.values())
        leased_gpu_ids = {
            device_id for lease in self._leases.values() for device_id in lease.gpu_device_ids
        }
        available_cpu = max(0.0, self._capacity.cpu_cores - used_cpu)
        lease_memory = max(0, self._capacity.memory_bytes - used_memory)
        available_memory = min(lease_memory, snapshot.memory_available_bytes)
        shortages: list[ResourceShortage] = []
        if request.cpu_cores > available_cpu:
            shortages.append(
                ResourceShortage(
                    "cpu_cores",
                    request.cpu_cores,
                    available_cpu,
                    "authorized CPU is held by active platform leases",
                )
            )
        if request.memory_bytes > available_memory:
            shortages.append(
                ResourceShortage(
                    "memory_bytes",
                    request.memory_bytes,
                    available_memory,
                    "memory is leased or not currently available on the host",
                )
            )

        observed = {gpu.device_id: gpu for gpu in snapshot.gpus}
        candidates = []
        for gpu in self._eligible_capacity_gpus(request):
            observation = observed.get(gpu.device_id)
            if gpu.device_id in leased_gpu_ids or observation is None:
                continue
            if observation.memory_free_bytes < request.gpu.min_memory_bytes:
                continue
            if observation.compute_process_count != 0:
                continue
            candidates.append(gpu.device_id)
        selected = tuple(candidates[: request.gpu.count])
        if len(selected) < request.gpu.count:
            shortages.append(
                ResourceShortage(
                    "gpus",
                    request.gpu.count,
                    len(selected),
                    "eligible GPUs are leased, externally occupied, or lack fresh free memory",
                )
            )
        return tuple(shortages), selected

    def _eligible_capacity_gpus(self, request: ResourceRequest) -> tuple[GpuCapacity, ...]:
        explicit = set(request.gpu.device_ids)
        return tuple(
            gpu
            for gpu in self._capacity.gpus
            if gpu.vendor == request.gpu.vendor
            and gpu.memory_total_bytes >= request.gpu.min_memory_bytes
            and (not explicit or gpu.device_id in explicit)
        )
