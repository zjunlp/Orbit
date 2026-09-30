"""One local lease database across state roots, with per-controller/batch quotas."""

import hashlib
import os
from pathlib import Path

from agent_infra.resources.api import LeaseCapacity, PersistentResourceLease
from agent_infra.resources.monitor import LinuxHostResourceMonitor
from agent_infra.resources.persistent import PersistentLeaseStore


def _node_root() -> Path:
    base = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state")))
    return Path(
        os.environ.get("AGENT_INFRA_NODE_STATE", str(base / "agent-infra-node"))
    ).expanduser()


def list_node_leases(scope: Path) -> tuple[PersistentResourceLease, ...]:
    """Observe this scope without creating or migrating a scheduler database."""
    root = _node_root() / "leases"
    if not (root / "leases.sqlite3").is_file():
        return ()
    identity = hashlib.sha256(str(scope.resolve()).encode()).hexdigest()
    return PersistentLeaseStore(root, scope=identity, read_only=True).list()


def node_leases(scope: Path, capacity: LeaseCapacity | None = None) -> PersistentLeaseStore:
    monitor = LinuxHostResourceMonitor()
    snapshot = monitor.sample()
    identity = hashlib.sha256(str(scope.resolve()).encode()).hexdigest()
    store = PersistentLeaseStore(
        _node_root() / "leases",
        LeaseCapacity(
            256, snapshot.cpu_logical_cores, snapshot.memory_total_bytes, len(snapshot.gpus)
        ),
        observe=monitor.sample,
        scope=identity,
    )
    if capacity is not None and store.capacity != capacity:
        store.configure(capacity)
    return store
