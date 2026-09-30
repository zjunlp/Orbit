"""SQLite-backed node and external-domain leases with fencing and scoped quotas."""

from __future__ import annotations

import json
import sqlite3
import uuid
from collections.abc import Callable, Sequence
from contextlib import closing
from dataclasses import asdict, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from agent_infra.resources.api import (
    AllocationStatus,
    HostResourceSnapshot,
    LeaseCapacity,
    PersistentLeaseDecision,
    PersistentLeaseState,
    PersistentResourceLease,
    ResourceClaim,
    ResourceShortage,
)


def _now() -> datetime:
    return datetime.now(UTC)


class PersistentLeaseStore:
    """Idempotent claims with fencing epochs and retained release history.

    Defaults to one active lease. Numeric limits are enforced only when an operator supplies
    them; otherwise the ledger claims slots, not cgroups or physical GPU allocations.
    """

    def __init__(
        self,
        root: Path,
        capacity: LeaseCapacity | None = None,
        *,
        read_only: bool = False,
        observe: Callable[[], HostResourceSnapshot] | None = None,
        scope: str = "",
    ) -> None:
        self.read_only = read_only
        self.observe = observe
        self.scope = scope
        if read_only:
            if capacity is not None or not (root / "leases.sqlite3").is_file():
                raise ValueError("read-only lease store requires an existing database")
        else:
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = root / "leases.sqlite3"
        if read_only:
            with closing(self._connect()) as db:
                if db.execute("PRAGMA user_version").fetchone()[0] not in (1, 2):
                    raise ValueError("unsupported persistent lease schema")
            return
        with closing(self._connect()) as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1, 2):
                raise ValueError("unsupported persistent lease schema")
            db.execute(
                """CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY, value TEXT NOT NULL
                )"""
            )
            db.execute(
                """CREATE TABLE IF NOT EXISTS leases (
                    lease_id TEXT PRIMARY KEY,
                    request_id TEXT UNIQUE NOT NULL,
                    owner_id TEXT UNIQUE NOT NULL,
                    claim TEXT NOT NULL,
                    owner_epoch INTEGER NOT NULL,
                    state TEXT NOT NULL,
                    native_id TEXT,
                    cleanup_confirmed INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )"""
            )
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT value FROM settings WHERE key='capacity'").fetchone()
            if row is None:
                initial_capacity = capacity or LeaseCapacity()
                encoded = json.dumps(asdict(initial_capacity), sort_keys=True)
                db.execute("INSERT INTO settings VALUES ('capacity', ?)", (encoded,))
            else:
                persisted = LeaseCapacity(**json.loads(row[0]))
                if capacity is not None and capacity != persisted and not scope:
                    raise ValueError(
                        "lease capacity differs from persisted scheduler configuration"
                    )
            db.execute("PRAGMA user_version=2")
            if scope:
                db.execute(
                    "INSERT OR IGNORE INTO settings VALUES (?, ?)",
                    ("scope:" + scope, json.dumps(asdict(LeaseCapacity()))),
                )
            db.commit()
        self.path.chmod(0o600)

    def configure(self, capacity: LeaseCapacity) -> LeaseCapacity:
        """Change authorized capacity only when every prior lease is released."""
        if self.read_only:
            raise ValueError("read-only lease store")
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            active = db.execute(
                "SELECT claim FROM leases WHERE state != ?",
                (PersistentLeaseState.RELEASED.value,),
            ).fetchall()
            if any(
                not self.scope or json.loads(row[0]).get("scope", "") == self.scope
                for row in active
            ):
                raise ValueError("drain and reconcile leases in this scope before capacity change")
            db.execute(
                "UPDATE settings SET value=? WHERE key=?",
                (
                    json.dumps(asdict(capacity), sort_keys=True),
                    "scope:" + self.scope if self.scope else "capacity",
                ),
            )
            db.commit()
        return capacity

    @property
    def capacity(self) -> LeaseCapacity:
        """Read the current setting so long-lived workers see administrator updates."""
        with closing(self._connect()) as db:
            row = db.execute(
                "SELECT value FROM settings WHERE key=?",
                ("scope:" + self.scope if self.scope else "capacity",),
            ).fetchone()
        assert row is not None
        return LeaseCapacity(**json.loads(row[0]))

    def _connect(self) -> sqlite3.Connection:
        db = (
            sqlite3.connect(self.path.absolute().as_uri() + "?mode=ro", uri=True, timeout=15)
            if self.read_only
            else sqlite3.connect(self.path, timeout=15)
        )
        db.row_factory = sqlite3.Row
        if not self.read_only:
            db.execute("PRAGMA synchronous=FULL")
        return db

    @staticmethod
    def _claim_payload(claim: ResourceClaim) -> str:
        value = asdict(claim)
        if not claim.gpu_device_ids:
            value.pop("gpu_device_ids")  # Preserve version-1 request identities.
        if not claim.scope:
            value.pop("scope")
        return json.dumps(value, sort_keys=True)

    @staticmethod
    def _lease(row: sqlite3.Row) -> PersistentResourceLease:
        return PersistentResourceLease(
            lease_id=row["lease_id"],
            claim=ResourceClaim(**json.loads(row["claim"])),
            owner_epoch=int(row["owner_epoch"]),
            state=PersistentLeaseState(row["state"]),
            native_id=row["native_id"],
            cleanup_confirmed=bool(row["cleanup_confirmed"]),
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )

    def acquire(self, claim: ResourceClaim) -> PersistentLeaseDecision:
        claim = replace(claim, scope=self.scope)
        payload = self._claim_payload(claim)
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            capacity_row = db.execute("SELECT value FROM settings WHERE key='capacity'").fetchone()
            assert capacity_row is not None
            capacity = LeaseCapacity(**json.loads(capacity_row[0]))
            existing = db.execute(
                "SELECT * FROM leases WHERE request_id=? OR owner_id=?",
                (claim.request_id, claim.owner_id),
            ).fetchone()
            if existing is not None:
                if existing["claim"] != payload:
                    raise ValueError("lease request or owner already has a different claim")
                db.commit()
                return PersistentLeaseDecision(AllocationStatus.GRANTED, self._lease(existing))

            impossible = self._capacity_shortages(claim, capacity)
            if impossible:
                db.commit()
                return PersistentLeaseDecision(AllocationStatus.UNSATISFIABLE, shortages=impossible)
            active = db.execute(
                "SELECT * FROM leases WHERE state != ? ORDER BY created_at, lease_id",
                (PersistentLeaseState.RELEASED.value,),
            ).fetchall()
            temporary = self._temporary_shortages(claim, active, capacity)
            if self.scope:
                scope_row = db.execute(
                    "SELECT value FROM settings WHERE key=?", ("scope:" + self.scope,)
                ).fetchone()
                assert scope_row is not None
                scope_capacity = LeaseCapacity(**json.loads(scope_row[0]))
                scoped_active = [
                    row for row in active if json.loads(row["claim"]).get("scope") == self.scope
                ]
                impossible = self._capacity_shortages(claim, scope_capacity)
                if impossible:
                    db.commit()
                    return PersistentLeaseDecision(
                        AllocationStatus.UNSATISFIABLE, shortages=impossible
                    )
                temporary += self._temporary_shortages(claim, scoped_active, scope_capacity)
            if not temporary and self.observe is not None and claim.allocator != "external":
                snapshot = self.observe()
                temporary = self._observed_shortages(claim, snapshot)
            if temporary:
                db.commit()
                return PersistentLeaseDecision(AllocationStatus.WAITING, shortages=temporary)

            timestamp = _now()
            lease_id = "lease_" + uuid.uuid4().hex
            db.execute(
                "INSERT INTO leases VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    lease_id,
                    claim.request_id,
                    claim.owner_id,
                    payload,
                    1,
                    PersistentLeaseState.ALLOCATED.value,
                    None,
                    0,
                    timestamp.isoformat(),
                    timestamp.isoformat(),
                ),
            )
            row = db.execute("SELECT * FROM leases WHERE lease_id=?", (lease_id,)).fetchone()
            db.commit()
        assert row is not None
        return PersistentLeaseDecision(AllocationStatus.GRANTED, self._lease(row))

    def get(self, lease_id: str) -> PersistentResourceLease:
        with closing(self._connect()) as db:
            row = db.execute("SELECT * FROM leases WHERE lease_id=?", (lease_id,)).fetchone()
        if row is None:
            raise KeyError(lease_id)
        return self._lease(row)

    def list(self) -> tuple[PersistentResourceLease, ...]:
        with closing(self._connect()) as db:
            rows = db.execute("SELECT * FROM leases ORDER BY created_at, lease_id").fetchall()
        return tuple(
            self._lease(row)
            for row in rows
            if not self.scope or json.loads(row["claim"]).get("scope") == self.scope
        )

    def bind_native(
        self, lease_id: str, owner_epoch: int, *, backend: str, native_id: str
    ) -> PersistentResourceLease:
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._owned(db, lease_id, owner_epoch)
            claim = ResourceClaim(**json.loads(row["claim"]))
            if claim.backend != backend:
                raise ValueError("native backend differs from the admitted lease")
            if row["native_id"] not in (None, native_id):
                raise ValueError("lease is already bound to another native job")
            if row["state"] == PersistentLeaseState.RELEASED.value:
                raise ValueError("released lease cannot bind a native job")
            db.execute(
                "UPDATE leases SET native_id=?, state=?, updated_at=? WHERE lease_id=?",
                (native_id, PersistentLeaseState.ACTIVE.value, _now().isoformat(), lease_id),
            )
            updated = db.execute("SELECT * FROM leases WHERE lease_id=?", (lease_id,)).fetchone()
            db.commit()
        assert updated is not None
        return self._lease(updated)

    def reconcile(self, lease_id: str, owner_epoch: int, reason: str) -> PersistentResourceLease:
        if not reason:
            raise ValueError("reconciliation reason is required")
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._owned(db, lease_id, owner_epoch)
            if row["state"] != PersistentLeaseState.RELEASED.value:
                db.execute(
                    "UPDATE leases SET state=?, updated_at=? WHERE lease_id=?",
                    (PersistentLeaseState.RECONCILING.value, _now().isoformat(), lease_id),
                )
            updated = db.execute("SELECT * FROM leases WHERE lease_id=?", (lease_id,)).fetchone()
            db.commit()
        assert updated is not None
        return self._lease(updated)

    def release(
        self, lease_id: str, owner_epoch: int, *, cleanup_confirmed: bool
    ) -> PersistentResourceLease:
        if not cleanup_confirmed:
            raise ValueError("lease release requires positive cleanup evidence")
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            self._owned(db, lease_id, owner_epoch)
            db.execute(
                "UPDATE leases SET state=?, cleanup_confirmed=1, updated_at=? WHERE lease_id=?",
                (PersistentLeaseState.RELEASED.value, _now().isoformat(), lease_id),
            )
            updated = db.execute("SELECT * FROM leases WHERE lease_id=?", (lease_id,)).fetchone()
            db.commit()
        assert updated is not None
        return self._lease(updated)

    @staticmethod
    def _owned(db: sqlite3.Connection, lease_id: str, owner_epoch: int) -> sqlite3.Row:
        row = db.execute("SELECT * FROM leases WHERE lease_id=?", (lease_id,)).fetchone()
        if row is None:
            raise KeyError(lease_id)
        if int(row["owner_epoch"]) != owner_epoch:
            raise ValueError("stale lease owner epoch")
        return cast(sqlite3.Row, row)

    @staticmethod
    def _capacity_shortages(
        claim: ResourceClaim, capacity: LeaseCapacity
    ) -> tuple[ResourceShortage, ...]:
        shortages = []
        for name, requested, available in (
            ("cpu_cores", claim.cpu_cores, capacity.cpu_cores),
            ("memory_bytes", claim.memory_bytes, capacity.memory_bytes),
            ("gpus", claim.gpu_count, capacity.gpu_count),
        ):
            if requested is not None and available is not None and requested > available:
                shortages.append(
                    ResourceShortage(
                        name,
                        requested,
                        available,
                        "request exceeds the persisted scheduler capacity",
                    )
                )
        return tuple(shortages)

    @staticmethod
    def _temporary_shortages(
        claim: ResourceClaim, active: Sequence[sqlite3.Row], capacity: LeaseCapacity
    ) -> tuple[ResourceShortage, ...]:
        if len(active) >= capacity.max_concurrent:
            return (
                ResourceShortage(
                    "concurrency_slots",
                    1,
                    0,
                    "authorized benchmark slots are held by durable leases",
                ),
            )
        shortages = []
        claims = [ResourceClaim(**json.loads(row["claim"])) for row in active]
        if claim.gpu_count:
            requested_ids = set(claim.gpu_device_ids)
            if any(
                item.gpu_count
                and (
                    not requested_ids
                    or not item.gpu_device_ids
                    or requested_ids.intersection(item.gpu_device_ids)
                )
                for item in claims
            ):
                shortages.append(
                    ResourceShortage(
                        "gpu_devices",
                        len(requested_ids),
                        0,
                        "GPU devices are held by durable leases",
                    )
                )
        for name, requested, available in (
            ("cpu_cores", claim.cpu_cores, capacity.cpu_cores),
            ("memory_bytes", claim.memory_bytes, capacity.memory_bytes),
            ("gpus", claim.gpu_count, capacity.gpu_count),
        ):
            if requested is None or available is None:
                continue
            attribute = name if name != "gpus" else "gpu_count"
            used = sum(getattr(item, attribute) or 0 for item in claims)
            if requested > available - used:
                shortages.append(
                    ResourceShortage(
                        name,
                        requested,
                        max(0, available - used),
                        "authorized capacity is held by durable leases",
                    )
                )
        return tuple(shortages)

    @staticmethod
    def _observed_shortages(
        claim: ResourceClaim, snapshot: HostResourceSnapshot
    ) -> tuple[ResourceShortage, ...]:
        age = (datetime.now(UTC) - snapshot.captured_at).total_seconds()
        if not 0 <= age <= 15:
            return (ResourceShortage("telemetry", "fresh", "stale", "host telemetry is stale"),)
        shortages = []
        if claim.memory_bytes and claim.memory_bytes > snapshot.memory_available_bytes:
            shortages.append(
                ResourceShortage(
                    "memory_bytes",
                    claim.memory_bytes,
                    snapshot.memory_available_bytes,
                    "host memory is busy",
                )
            )
        observed = {gpu.device_id: gpu for gpu in snapshot.gpus}
        if (
            claim.gpu_count
            and not claim.gpu_device_ids
            and (
                len(observed) < claim.gpu_count
                or any(gpu.compute_process_count != 0 for gpu in observed.values())
            )
        ):
            shortages.append(
                ResourceShortage(
                    "gpu_devices",
                    claim.gpu_count,
                    "unknown assignment",
                    "unbound GPU claims require an idle inventory",
                )
            )
        for device in claim.gpu_device_ids:
            gpu = observed.get(device)
            if gpu is None or gpu.compute_process_count != 0:
                shortages.append(
                    ResourceShortage(
                        "gpu_devices",
                        device,
                        "unavailable",
                        "requested GPU is missing or externally occupied",
                    )
                )
        return tuple(shortages)
