"""One local lease database across state roots, with per-controller/batch quotas."""

import hashlib
import os
from pathlib import Path

from agent_infra.resources.api import LeaseCapacity
from agent_infra.resources.monitor import LinuxHostResourceMonitor
from agent_infra.resources.persistent import PersistentLeaseStore


def node_leases(scope: Path, capacity: LeaseCapacity | None = None) -> PersistentLeaseStore:
    monitor = LinuxHostResourceMonitor()
    snapshot = monitor.sample()
    base = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state")))
    root = Path(
        os.environ.get("AGENT_INFRA_NODE_STATE", str(base / "agent-infra-node"))
    ).expanduser()
    identity = hashlib.sha256(str(scope.resolve()).encode()).hexdigest()
    store = PersistentLeaseStore(
        root / "leases",
        LeaseCapacity(
            256, snapshot.cpu_logical_cores, snapshot.memory_total_bytes, len(snapshot.gpus)
        ),
        observe=monitor.sample,
        scope=identity,
    )
    if capacity is not None and store.capacity != capacity:
        store.configure(capacity)
    return store
