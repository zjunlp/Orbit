"""Durable command intent. Execution evidence remains in Records, not this database."""

from __future__ import annotations

import fcntl
import json
import os
import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from agent_infra.runs.control_api import ControlError


def now() -> str:
    return datetime.now(UTC).isoformat()


class RunControlStore:
    @contextmanager
    def exclusive(self) -> Iterator[None]:
        """Serialize a multi-store control operation across local CLI processes."""
        fd = os.open(self.path.with_suffix(".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def __init__(self, root: Path, *, read_only: bool = False) -> None:
        self.path = root / "control.sqlite3"
        self.read_only = read_only
        if read_only:
            with closing(self._connect()) as db:
                if db.execute("PRAGMA user_version").fetchone()[0] != 1:
                    raise ValueError("unsupported run control schema; use a compatible version")
            return
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with closing(self._connect()) as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise ValueError("unsupported run control schema; use a compatible version")
            db.execute("""CREATE TABLE IF NOT EXISTS commands (
                operation_id TEXT PRIMARY KEY, run_id TEXT UNIQUE NOT NULL,
                project_id TEXT, payload TEXT NOT NULL, document TEXT NOT NULL)""")
            db.commit()
            db.execute("CREATE INDEX IF NOT EXISTS commands_project ON commands(project_id)")
            db.execute("PRAGMA user_version=1")
        self.path.chmod(0o600)

    def _connect(self) -> sqlite3.Connection:
        db = (
            sqlite3.connect(self.path.absolute().as_uri() + "?mode=ro", uri=True, timeout=15)
            if self.read_only
            else sqlite3.connect(self.path, timeout=15)
        )
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA synchronous=FULL")
        return db

    def lookup(self, operation_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        with closing(self._connect()) as db:
            row = db.execute(
                "SELECT * FROM commands WHERE operation_id=?", (operation_id,)
            ).fetchone()
        if row is None:
            return None
        if json.loads(row["payload"]) != payload:
            raise ControlError(
                "idempotency_conflict", "operation_id already has different parameters"
            )
        return dict(json.loads(row["document"]))

    def find_operation(self, operation_id: str) -> dict[str, Any] | None:
        """Read admission identity before doing expensive input resolution."""
        with closing(self._connect()) as db:
            row = db.execute(
                "SELECT document FROM commands WHERE operation_id=?", (operation_id,)
            ).fetchone()
        return json.loads(row[0]) if row else None

    def create(
        self,
        operation_id: str,
        payload: dict[str, Any],
        lineage: dict[str, Any],
        *,
        initial_state: str = "accepted",
        launch_authorized: bool = False,
    ) -> dict[str, Any]:
        if initial_state not in {"accepted", "queued"}:
            raise ValueError("unsupported initial control state")
        document = {
            "operation_id": operation_id,
            "run_id": uuid.uuid4().hex,
            "attempt_id": "attempt_" + uuid.uuid4().hex,
            "state": initial_state,
            "cancel_requested": False,
            "created_at": now(),
            "updated_at": now(),
            "request": payload,
            "lineage": lineage,
            "result": None,
        }
        if launch_authorized:
            document["launch_authorized"] = True
        with closing(self._connect()) as db:
            db.execute(
                "INSERT INTO commands VALUES (?,?,?,?,?)",
                (
                    operation_id,
                    document["run_id"],
                    lineage.get("project_id"),
                    json.dumps(payload, sort_keys=True),
                    json.dumps(document),
                ),
            )
            db.commit()
        return document

    def get(self, run_id: str) -> dict[str, Any]:
        with closing(self._connect()) as db:
            row = db.execute("SELECT document FROM commands WHERE run_id=?", (run_id,)).fetchone()
        if row is None:
            raise KeyError(run_id)
        return dict(json.loads(row["document"]))

    def update(self, run_id: str, **fields: Any) -> dict[str, Any]:
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT document FROM commands WHERE run_id=?", (run_id,)).fetchone()
            if row is None:
                raise KeyError(run_id)
            document = json.loads(row["document"]) | fields | {"updated_at": now()}
            db.execute(
                "UPDATE commands SET document=? WHERE run_id=?", (json.dumps(document), run_id)
            )
            db.commit()
        return dict(document)

    def list_runs(
        self, *, project_id: str | None = None, limit: int = 100, offset: int = 0
    ) -> list[dict[str, Any]]:
        if not 1 <= limit <= 500 or offset < 0:
            raise ValueError("invalid pagination")
        with closing(self._connect()) as db:
            rows = db.execute(
                "SELECT document FROM commands WHERE (? IS NULL OR project_id=?) "
                "ORDER BY rowid DESC LIMIT ? OFFSET ?",
                (project_id, project_id, limit, offset),
            ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def unfinished(self) -> list[dict[str, Any]]:
        with closing(self._connect()) as db:
            rows = db.execute("SELECT document FROM commands ORDER BY rowid").fetchall()
        return [item for row in rows if (item := json.loads(row[0]))["state"] != "finished"]

    def ordered(self) -> list[dict[str, Any]]:
        """All commands in durable admission order, including completed budget charges."""
        with closing(self._connect()) as db:
            rows = db.execute("SELECT document FROM commands ORDER BY rowid").fetchall()
        return [json.loads(row[0]) for row in rows]

    def queue_position(self, run_id: str) -> int | None:
        """One-based FIFO position among launch-authorized queued commands."""
        queued = [
            item
            for item in self.unfinished()
            if item["state"] == "queued" and item.get("launch_authorized") is True
        ]
        for position, item in enumerate(queued, start=1):
            if item["run_id"] == run_id:
                return position
        return None

    def queued(self) -> list[dict[str, Any]]:
        return [
            item
            for item in self.unfinished()
            if item["state"] == "queued" and item.get("launch_authorized") is True
        ]
