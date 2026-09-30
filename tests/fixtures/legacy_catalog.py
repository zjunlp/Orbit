"""Write fixed pre-migration SQLite data, without keeping a second catalog implementation."""

import json
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any


def seed_catalog(
    path: Path,
    projects: list[dict[str, Any]],
    tasks: tuple[tuple[str, str, str], ...] = (),
    bindings: tuple[tuple[str, str], ...] = (),
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as db:
        db.executescript(
            "CREATE TABLE projects (id TEXT PRIMARY KEY,"
            "revision INTEGER NOT NULL,body TEXT NOT NULL);"
            "CREATE TABLE workspace_bindings (legacy_id TEXT PRIMARY KEY,"
            "project_id TEXT UNIQUE NOT NULL);"
            "CREATE TABLE task_identities (task_key TEXT PRIMARY KEY,"
            "task_id TEXT NOT NULL,revision TEXT NOT NULL);"
        )
        db.executemany(
            "INSERT INTO projects VALUES (?,?,?)",
            ((p["id"], p["revision"], json.dumps(p)) for p in projects),
        )
        db.executemany("INSERT INTO task_identities VALUES (?,?,?)", tasks)
        db.executemany("INSERT INTO workspace_bindings VALUES (?,?)", bindings)
        db.commit()
