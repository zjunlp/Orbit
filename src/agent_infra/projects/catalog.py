"""Project-owned console metadata with a read-only bridge to the old catalog file.

Reads preserve the old file. The first explicit metadata write snapshots that source into
Projects; subsequent writes never update the legacy database. Stop older writers on upgrade.
"""

import hashlib
import json
import sqlite3
from collections.abc import Callable
from contextlib import closing
from pathlib import Path
from typing import Any

from agent_infra.projects.local import LocalProjectStore
from agent_infra.records.catalog import CatalogConflict


class ProjectCatalogBridge:
    def __init__(self, projects: LocalProjectStore, legacy_path: Path) -> None:
        self.projects, self.path = projects, legacy_path.resolve()
        self.source_id = hashlib.sha256(str(self.path).encode()).hexdigest()

    def _legacy(self) -> dict[str, Any]:
        document: dict[str, Any] = {"projects": {}, "bindings": {}, "tasks": {}}
        if not self.path.exists():
            return document
        with closing(sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True)) as db:
            tables = {
                row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            if "projects" in tables:
                document["projects"] = {
                    row[0]: json.loads(row[1]) for row in db.execute("SELECT id,body FROM projects")
                }
            if "workspace_bindings" in tables:
                document["bindings"] = dict(
                    db.execute("SELECT legacy_id,project_id FROM workspace_bindings")
                )
            if "task_identities" in tables:
                document["tasks"] = {
                    row[0]: {"task_id": row[1], "revision": row[2]}
                    for row in db.execute("SELECT task_key,task_id,revision FROM task_identities")
                }
        return document

    def _read(self, db: sqlite3.Connection) -> dict[str, Any]:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name='console_catalog'").fetchone():
            return self._legacy()
        row = db.execute(
            "SELECT body FROM console_catalog WHERE source_id=?", (self.source_id,)
        ).fetchone()
        return json.loads(row[0]) if row else self._legacy()

    def _document(self) -> dict[str, Any]:
        try:
            with self.projects.database.connect() as db:
                return self._read(db)
        except FileNotFoundError:
            return self._legacy()

    def _write(self, change: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        with self.projects.database.writer(), self.projects.database.connect(write=True) as db:
            document = self._read(db)
            change(document)
            db.execute(
                "INSERT OR REPLACE INTO console_catalog VALUES (?,?)",
                (self.source_id, json.dumps(document, ensure_ascii=False)),
            )
            return document

    def list_projects(self) -> list[dict[str, Any]]:
        projects = self._document()["projects"]
        return [projects[key] for key in sorted(projects)]

    def save(self, project: dict[str, Any], expected_revision: int) -> dict[str, Any]:
        def change(document: dict[str, Any]) -> None:
            previous = document["projects"].get(project["id"], {}).get("revision", 0)
            if previous != expected_revision:
                raise CatalogConflict("项目已被修改，请刷新后重试")
            document["projects"][project["id"]] = project | {"revision": previous + 1}

        return dict(self._write(change)["projects"][project["id"]])

    def bindings(self) -> dict[str, str]:
        return dict(self._document()["bindings"])

    def bind(self, legacy_id: str, project_id: str) -> None:
        def change(document: dict[str, Any]) -> None:
            if legacy_id not in document["projects"]:
                raise KeyError(legacy_id)
            bindings = document["bindings"]
            if bindings.get(legacy_id, project_id) != project_id or any(
                key != legacy_id and value == project_id for key, value in bindings.items()
            ):
                raise CatalogConflict("工作区已经绑定其他旧项目")
            bindings[legacy_id] = project_id

        self._write(change)

    def remember_tasks(self, tasks: list[dict[str, Any]]) -> None:
        observed = {
            task["key"]: {"task_id": task["task_id"], "revision": task["revision"]}
            for task in tasks
            if not task.get("error")
        }
        if not observed or observed.keys() <= self._document()["tasks"].keys():
            return

        def change(document: dict[str, Any]) -> None:
            for key, identity in observed.items():
                document["tasks"].setdefault(key, identity)

        self._write(change)

    def task_identities(self) -> dict[str, dict[str, str]]:
        return dict(self._document()["tasks"])
