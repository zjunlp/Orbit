"""Legacy console catalog API. New production writes use projects.catalog.

LocalProjectCatalog remains available for old clients and historical fixtures; it is
not constructed by the production console. Do not run old and new catalog writers together.
"""

import json
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any, Protocol


class CatalogConflict(ValueError):
    """A concurrent edit changed the project revision."""


class ProjectCatalog(Protocol):
    def list_projects(self) -> list[dict[str, Any]]: ...

    def save(self, project: dict[str, Any], expected_revision: int) -> dict[str, Any]: ...

    def bindings(self) -> dict[str, str]: ...

    def bind(self, legacy_id: str, project_id: str) -> None: ...

    def remember_tasks(self, tasks: list[dict[str, Any]]) -> None: ...

    def task_identities(self) -> dict[str, dict[str, str]]: ...


class LocalProjectCatalog:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = path
        with closing(sqlite3.connect(path)) as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS projects "
                "(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL)"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS workspace_bindings "
                "(legacy_id TEXT PRIMARY KEY, project_id TEXT UNIQUE NOT NULL)"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS task_identities "
                "(task_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision TEXT NOT NULL)"
            )
            db.commit()
        path.chmod(0o600)

    def list_projects(self) -> list[dict[str, Any]]:
        with closing(sqlite3.connect(self.path)) as db:
            return [
                json.loads(row[0]) for row in db.execute("SELECT body FROM projects ORDER BY id")
            ]

    def save(self, project: dict[str, Any], expected_revision: int) -> dict[str, Any]:
        with closing(sqlite3.connect(self.path, timeout=10)) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT revision FROM projects WHERE id=?", (project["id"],)
            ).fetchone()
            if (row[0] if row else 0) != expected_revision:
                raise CatalogConflict("项目已被修改，请刷新后重试")
            saved = project | {"revision": expected_revision + 1}
            db.execute(
                "INSERT INTO projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET "
                "revision=excluded.revision,body=excluded.body",
                (saved["id"], saved["revision"], json.dumps(saved, ensure_ascii=False)),
            )
            db.commit()
        return saved

    def bindings(self) -> dict[str, str]:
        with closing(sqlite3.connect(self.path)) as db:
            return dict(db.execute("SELECT legacy_id,project_id FROM workspace_bindings"))

    def bind(self, legacy_id: str, project_id: str) -> None:
        """Explicit, immutable alias. Repeating the same binding is harmless."""
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (legacy_id,)).fetchone():
                raise KeyError(legacy_id)
            old = db.execute(
                "SELECT project_id FROM workspace_bindings WHERE legacy_id=?", (legacy_id,)
            ).fetchone()
            if old and old[0] != project_id:
                raise CatalogConflict("旧项目已绑定其他工作区；请核对项目身份")
            try:
                db.execute(
                    "INSERT OR IGNORE INTO workspace_bindings VALUES (?,?)", (legacy_id, project_id)
                )
                actual = db.execute(
                    "SELECT project_id FROM workspace_bindings WHERE legacy_id=?", (legacy_id,)
                ).fetchone()
                if actual is None:
                    raise CatalogConflict("该工作区已绑定其他旧项目")
                db.commit()
            except sqlite3.IntegrityError as error:
                raise CatalogConflict("工作区绑定冲突") from error

    def remember_tasks(self, tasks: list[dict[str, Any]]) -> None:
        """Pin legacy path keys to identities; changed/missing tasks remain unresolved."""
        with closing(sqlite3.connect(self.path)) as db:
            for task in tasks:
                if not task.get("error"):
                    db.execute(
                        "INSERT OR IGNORE INTO task_identities VALUES (?,?,?)",
                        (task["key"], task["task_id"], task["revision"]),
                    )
            db.commit()

    def task_identities(self) -> dict[str, dict[str, str]]:
        with closing(sqlite3.connect(self.path)) as db:
            return {
                row[0]: {"task_id": row[1], "revision": row[2]}
                for row in db.execute("SELECT task_key,task_id,revision FROM task_identities")
            }
