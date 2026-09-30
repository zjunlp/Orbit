"""Explicit project ownership and incremental cursors for native Agent sessions."""

import sqlite3
from dataclasses import dataclass

from agent_infra.projects.api import ProjectConflict
from agent_infra.projects.local import LocalProjectStore


@dataclass(frozen=True)
class SessionBinding:
    provider: str
    session_id: str
    project_id: str
    started_at: str
    cwd: str
    parent_session_id: str | None = None
    next_offset: int = 0
    next_line: int = 0
    prefix_digest: str | None = None

    @property
    def records_run_id(self) -> str:
        return f"host-{self.provider}-{self.session_id}"

    @property
    def records_attempt_id(self) -> str:
        return f"host-{self.provider}-attempt-{self.session_id}"


class SessionBindingStore:
    def __init__(self, projects: LocalProjectStore) -> None:
        self.projects = projects

    def list(self, project_id: str | None = None) -> tuple[SessionBinding, ...]:
        return self._read(**({"project_id": project_id} if project_id is not None else {}))

    def get(self, provider: str, session_id: str) -> SessionBinding | None:
        rows = self._read(provider=provider, session_id=session_id)
        return rows[0] if rows else None

    def _read(self, **filters: str) -> tuple[SessionBinding, ...]:
        try:
            with self.projects.database.connect() as db:
                generic = db.execute("PRAGMA user_version").fetchone()[0] >= 6
                query = (
                    "SELECT * FROM agent_sessions"
                    if generic
                    else (
                        "SELECT 'codex' AS provider,thread_id AS session_id,"
                        "project_id,started_at,cwd,"
                        "next_offset,next_line FROM codex_sessions"
                    )
                )
                if filters:
                    query += " WHERE " + " AND ".join(f"{key}=?" for key in filters)
                rows = db.execute(
                    query + " ORDER BY started_at DESC", tuple(filters.values())
                ).fetchall()
                return tuple(SessionBinding(**dict(row)) for row in rows)
        except FileNotFoundError:
            return ()
        except sqlite3.OperationalError as error:
            if "no such table" in str(error):
                return ()
            raise

    def bind(self, binding: SessionBinding) -> SessionBinding:
        with self.projects.database.writer(), self.projects.database.connect(write=True) as db:
            row = db.execute(
                "SELECT * FROM agent_sessions WHERE provider=? AND session_id=?",
                (binding.provider, binding.session_id),
            ).fetchone()
            if row is not None:
                existing = SessionBinding(**dict(row))
                if (
                    existing.project_id,
                    existing.started_at,
                    existing.cwd,
                    existing.parent_session_id,
                ) != (
                    binding.project_id,
                    binding.started_at,
                    binding.cwd,
                    binding.parent_session_id,
                ):
                    raise ProjectConflict(
                        "Agent session is already bound to another project or metadata"
                    )
                return existing
            if not db.execute(
                "SELECT 1 FROM projects WHERE id=?", (binding.project_id,)
            ).fetchone():
                raise ProjectConflict("session project does not exist")
            db.execute(
                "INSERT INTO agent_sessions(provider,session_id,project_id,started_at,cwd,"
                "parent_session_id) VALUES (?,?,?,?,?,?)",
                (
                    binding.provider,
                    binding.session_id,
                    binding.project_id,
                    binding.started_at,
                    binding.cwd,
                    binding.parent_session_id,
                ),
            )
            return binding

    def advance(
        self,
        binding: SessionBinding,
        expected_offset: int,
        next_offset: int,
        next_line: int,
        prefix_digest: str | None,
    ) -> None:
        with self.projects.database.writer(), self.projects.database.connect(write=True) as db:
            updated = db.execute(
                "UPDATE agent_sessions SET next_offset=?,next_line=?,prefix_digest=? "
                "WHERE provider=? AND session_id=? AND next_offset=?",
                (
                    next_offset,
                    next_line,
                    prefix_digest,
                    binding.provider,
                    binding.session_id,
                    expected_offset,
                ),
            )
            if updated.rowcount != 1:
                raise ProjectConflict("Agent capture cursor changed; retry synchronization")
