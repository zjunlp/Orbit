"""Local Project metadata. Read operations do not create state."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path

from agent_infra.projects._database import ProjectDatabase
from agent_infra.projects._research_store import ResearchStore
from agent_infra.projects.api import (
    InitializationStatus,
    Project,
    ProjectConflict,
    ProjectNotFound,
    ProjectStatus,
)


@dataclass(frozen=True)
class StoredProject:
    project: Project
    snapshot: dict[str, str]
    directories: tuple[str, ...]
    request: dict[str, str]


def _decode(row: sqlite3.Row) -> StoredProject:
    return StoredProject(
        Project.from_dict(json.loads(row["body"])),
        json.loads(row["snapshot"]),
        tuple(json.loads(row["directories"])),
        json.loads(row["request"]),
    )


class LocalProjectStore:
    def __init__(self, root: Path) -> None:
        self.database = ProjectDatabase(root)
        self.root = self.database.root
        self.path = self.database.path
        self.writer = self.database.writer
        research = ResearchStore(self)
        self.research_state = research.research_state
        self.research_revision = research.research_revision
        self.research_history = research.research_history
        self.save_research = research.save_research
        self.finish_research_export = research.finish_research_export
        self.confirm_research = research.confirm_research

    def find(
        self, *, operation: str | None = None, workspace: str | None = None
    ) -> StoredProject | None:
        try:
            with self.database.connect() as db:
                row = db.execute(
                    "SELECT * FROM projects WHERE operation=? OR workspace=?",
                    (operation, workspace),
                ).fetchall()
                if len(row) > 1:
                    raise ProjectConflict("operation and destination identify different projects")
                return _decode(row[0]) if row else None
        except FileNotFoundError:
            return None

    def get(self, project_id: str) -> StoredProject:
        try:
            with self.database.connect() as db:
                row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
                if row:
                    return _decode(row)
        except FileNotFoundError:
            pass
        raise ProjectNotFound(f"project not found: {project_id}")

    def list_projects(self) -> tuple[Project, ...]:
        try:
            with self.database.connect() as db:
                return tuple(
                    _decode(row).project for row in db.execute("SELECT * FROM projects ORDER BY id")
                )
        except FileNotFoundError:
            return ()

    def reserve(self, item: StoredProject) -> None:
        p = item.project
        try:
            with self.database.connect(write=True) as db:
                db.execute(
                    "INSERT INTO projects VALUES (?,?,?,?,?,?,?)",
                    (
                        p.project_id,
                        p.operation_id,
                        p.workspace,
                        json.dumps(p.to_dict()),
                        json.dumps(item.snapshot),
                        json.dumps(item.directories),
                        json.dumps(item.request),
                    ),
                )
        except sqlite3.IntegrityError as error:
            raise ProjectConflict("operation or destination is already registered") from error

    def mark_ready(self, project_id: str, manifest: str) -> Project:
        with self.database.connect(write=True) as db:
            row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
            if row is None:
                raise ProjectNotFound(project_id)
            item = _decode(row)
            p = replace(item.project, initialization=InitializationStatus.READY)
            db.execute(
                "UPDATE projects SET body=?, snapshot=? WHERE id=?",
                (
                    json.dumps(p.to_dict()),
                    json.dumps(item.snapshot | {"project.yaml": manifest}),
                    project_id,
                ),
            )
            return p

    def update(
        self,
        project_id: str,
        *,
        expected_revision: int,
        title: str | None = None,
        status: ProjectStatus | None = None,
    ) -> Project:
        """CAS metadata update; recover materializes the guarded manifest projection."""
        with self.writer(), self.database.connect(write=True) as db:
            row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
            if row is None:
                raise ProjectNotFound(project_id)
            p = _decode(row).project
            if type(expected_revision) is not int or p.revision != expected_revision:
                raise ProjectConflict("project revision changed; reload before updating")
            if p.initialization != InitializationStatus.READY:
                raise ProjectConflict("recover pending initialization/projection before updating")
            updated = replace(
                p,
                title=p.title if title is None else title,
                status=p.status if status is None else status,
                revision=p.revision + 1,
                updated_at=datetime.now(UTC).isoformat(),
                initialization=(
                    InitializationStatus.READY
                    if _decode(row).request.get("mode") == "attached"
                    else InitializationStatus.PROJECTION_PENDING
                ),
            )
            db.execute(
                "UPDATE projects SET body=? WHERE id=?", (json.dumps(updated.to_dict()), project_id)
            )
            return updated

    def reserve_rebind(self, project_id: str, workspace: str, expected_revision: int) -> Project:
        """Caller owns writer(); retain the old manifest for guarded projection recovery."""
        with self.database.connect(write=True) as db:
            row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
            if row is None:
                raise ProjectNotFound(project_id)
            project = _decode(row).project
            if (
                project.revision != expected_revision
                or project.initialization != InitializationStatus.READY
            ):
                raise ProjectConflict("project changed; reload or recover before rebinding")
            updated = replace(
                project,
                workspace=workspace,
                revision=project.revision + 1,
                updated_at=datetime.now(UTC).isoformat(),
                initialization=InitializationStatus.PROJECTION_PENDING,
            )
            try:
                db.execute(
                    "UPDATE projects SET workspace=?, body=? WHERE id=?",
                    (workspace, json.dumps(updated.to_dict()), project_id),
                )
            except sqlite3.IntegrityError as error:
                raise ProjectConflict("destination is already bound to another project") from error
            return updated
