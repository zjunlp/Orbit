"""Public resource requests, observations, allocations, and scheduler outcomes."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from math import isfinite
from typing import Protocol


@dataclass(frozen=True, slots=True)
class GpuRequest:
    count: int = 0
    min_memory_bytes: int = 0
    vendor: str = "nvidia"
    device_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.count < 0:
            raise ValueError("GPU count must be non-negative")
        if self.min_memory_bytes < 0:
            raise ValueError("GPU minimum memory must be non-negative")
        if self.device_ids and len(self.device_ids) != self.count:
            raise ValueError("GPU device_ids count must equal GPU count")
        if len(self.device_ids) != len(set(self.device_ids)):
            raise ValueError("GPU device_ids must be unique")
        if self.count and not self.vendor.strip():
            raise ValueError("GPU vendor must not be empty")


@dataclass(frozen=True, slots=True)
class ResourceRequest:
    request_id: str
    cpu_cores: float
    memory_bytes: int
    gpu: GpuRequest = GpuRequest()
    node_labels: tuple[tuple[str, str], ...] = ()
    wait_timeout_seconds: float = 0

    def __post_init__(self) -> None:
        if not self.request_id.strip():
            raise ValueError("request_id must not be empty")
        if not isfinite(self.cpu_cores) or self.cpu_cores <= 0:
            raise ValueError("cpu_cores must be positive")
        if self.memory_bytes <= 0:
            raise ValueError("memory_bytes must be positive")
        if not isfinite(self.wait_timeout_seconds) or self.wait_timeout_seconds < 0:
            raise ValueError("wait_timeout_seconds must be non-negative")
        keys = [key for key, _ in self.node_labels]
        if len(keys) != len(set(keys)):
            raise ValueError("node label keys must be unique")

    def labels_dict(self) -> dict[str, str]:
        return dict(self.node_labels)


@dataclass(frozen=True, slots=True)
class GpuCapacity:
    device_id: str
    index: int
    name: str
    memory_total_bytes: int
    vendor: str = "nvidia"

    def __post_init__(self) -> None:
        if not self.device_id.strip() or not self.name.strip() or not self.vendor.strip():
            raise ValueError("GPU identity fields must not be empty")
        if self.index < 0 or self.memory_total_bytes <= 0:
            raise ValueError("GPU index and total memory must be valid")


@dataclass(frozen=True, slots=True)
class NodeCapacity:
    """Capacity that an administrator authorizes this platform to allocate."""

    node_id: str
    cpu_cores: float
    memory_bytes: int
    gpus: tuple[GpuCapacity, ...] = ()
    labels: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        if not self.node_id.strip():
            raise ValueError("node_id must not be empty")
        if not isfinite(self.cpu_cores) or self.cpu_cores <= 0 or self.memory_bytes <= 0:
            raise ValueError("authorized CPU and memory must be positive")
        gpu_ids = [gpu.device_id for gpu in self.gpus]
        if len(gpu_ids) != len(set(gpu_ids)):
            raise ValueError("authorized GPU device IDs must be unique")
        label_keys = [key for key, _ in self.labels]
        if len(label_keys) != len(set(label_keys)):
            raise ValueError("node label keys must be unique")

    def labels_dict(self) -> dict[str, str]:
        return dict(self.labels)


@dataclass(frozen=True, slots=True)
class GpuObservation:
    device_id: str
    index: int
    name: str
    memory_total_bytes: int
    memory_free_bytes: int
    utilization_percent: float | None
    compute_process_count: int | None


@dataclass(frozen=True, slots=True)
class HostResourceSnapshot:
    node_id: str
    captured_at: datetime
    cpu_logical_cores: int
    cpu_utilization_percent: float | None
    load_average_1m: float | None
    memory_total_bytes: int
    memory_available_bytes: int
    gpus: tuple[GpuObservation, ...] = ()
    issues: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.captured_at.tzinfo is None or self.captured_at.utcoffset() is None:
            raise ValueError("snapshot captured_at must include a timezone")
        if self.cpu_logical_cores <= 0 or self.memory_total_bytes <= 0:
            raise ValueError("snapshot CPU and total memory must be positive")
        if not 0 <= self.memory_available_bytes <= self.memory_total_bytes:
            raise ValueError("snapshot available memory must be within total memory")


@dataclass(frozen=True, slots=True)
class ResourceLease:
    lease_id: str
    request_id: str
    node_id: str
    cpu_cores: float
    memory_bytes: int
    gpu_device_ids: tuple[str, ...]
    created_at: datetime


class AllocationStatus(StrEnum):
    GRANTED = "granted"
    WAITING = "waiting"
    UNSATISFIABLE = "unsatisfiable"


@dataclass(frozen=True, slots=True)
class ResourceShortage:
    resource: str
    requested: float | int | str
    available: float | int | str
    reason: str


@dataclass(frozen=True, slots=True)
class AllocationDecision:
    status: AllocationStatus
    lease: ResourceLease | None = None
    shortages: tuple[ResourceShortage, ...] = ()

    def __post_init__(self) -> None:
        if (self.status is AllocationStatus.GRANTED) != (self.lease is not None):
            raise ValueError("only a granted decision may contain a lease")


@dataclass(frozen=True, slots=True)
class ResourceAssessment:
    status: AllocationStatus
    shortages: tuple[ResourceShortage, ...] = ()


class ResourceManager(Protocol):
    def update_snapshot(self, snapshot: HostResourceSnapshot) -> None: ...

    def try_allocate(self, request: ResourceRequest) -> AllocationDecision: ...

    def release(self, lease_id: str) -> bool: ...


@dataclass(frozen=True, slots=True)
class LeaseCapacity:
    """Operator-authorized BM05-A envelope; None means slot-only admission."""

    max_concurrent: int = 1
    cpu_cores: float | None = None
    memory_bytes: int | None = None
    gpu_count: int | None = None

    def __post_init__(self) -> None:
        if self.max_concurrent <= 0:
            raise ValueError("max_concurrent must be positive")
        if self.cpu_cores is not None and (not isfinite(self.cpu_cores) or self.cpu_cores <= 0):
            raise ValueError("lease capacity CPU must be positive")
        if self.memory_bytes is not None and self.memory_bytes <= 0:
            raise ValueError("lease capacity memory must be positive")
        if self.gpu_count is not None and self.gpu_count < 0:
            raise ValueError("lease capacity GPU count must be non-negative")


@dataclass(frozen=True, slots=True)
class ResourceClaim:
    request_id: str
    owner_id: str
    backend: str
    cpu_cores: float | None = None
    memory_bytes: int | None = None
    gpu_count: int | None = None
    allocator: str = "unspecified"
    gpu_device_ids: tuple[str, ...] = ()
    scope: str = ""

    def __post_init__(self) -> None:
        object.__setattr__(self, "gpu_device_ids", tuple(self.gpu_device_ids))
        if len(set(self.gpu_device_ids)) != len(self.gpu_device_ids):
            raise ValueError("claimed GPU IDs must be unique")
        if self.gpu_device_ids and len(self.gpu_device_ids) != self.gpu_count:
            raise ValueError("claimed GPU IDs must match GPU count")
        if not self.request_id or not self.owner_id or not self.backend:
            raise ValueError("claim request, owner, and backend IDs are required")
        if self.cpu_cores is not None and (not isfinite(self.cpu_cores) or self.cpu_cores <= 0):
            raise ValueError("claimed CPU must be positive")
        if self.memory_bytes is not None and self.memory_bytes <= 0:
            raise ValueError("claimed memory must be positive")
        if self.gpu_count is not None and self.gpu_count < 0:
            raise ValueError("claimed GPU count must be non-negative")


class PersistentLeaseState(StrEnum):
    ALLOCATED = "allocated"
    ACTIVE = "active"
    RECONCILING = "reconciling"
    RELEASED = "released"


@dataclass(frozen=True, slots=True)
class PersistentResourceLease:
    lease_id: str
    claim: ResourceClaim
    owner_epoch: int
    state: PersistentLeaseState
    native_id: str | None
    cleanup_confirmed: bool
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class PersistentLeaseDecision:
    status: AllocationStatus
    lease: PersistentResourceLease | None = None
    shortages: tuple[ResourceShortage, ...] = ()

    def __post_init__(self) -> None:
        if (self.status is AllocationStatus.GRANTED) != (self.lease is not None):
            raise ValueError("only a granted persistent decision may contain a lease")
