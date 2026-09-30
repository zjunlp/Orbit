"""Single connection, transaction and writer-lock implementation for Project stores."""

from __future__ import annotations

import fcntl
import os
import sqlite3
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from agent_infra.projects._filesystem import absolute, directory
from agent_infra.projects.api import ProjectError


class ProjectDatabase:
    def __init__(self, root: Path) -> None:
        self.root = absolute(root)
        self.path = self.root / "projects.sqlite3"

    @contextmanager
    def writer(self) -> Iterator[None]:
        with directory(self.root, create=True) as parent:
            fd = os.open(
                "writer.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=parent
            )
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ProjectError("invalid project store lock")
                fcntl.flock(fd, fcntl.LOCK_EX)
                yield
            finally:
                os.close(fd)

    @contextmanager
    def connect(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        with directory(self.root) as parent:
            if write:
                fd = os.open(
                    "projects.sqlite3", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=parent
                )
                os.close(fd)
            info = os.stat("projects.sqlite3", dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ProjectError("project store must be a private regular file")
            path = Path(f"/proc/self/fd/{parent}/projects.sqlite3")
            db = sqlite3.connect(
                path.as_uri() + ("?mode=rw" if write else "?mode=ro"), uri=True, timeout=30
            )
            db.row_factory = sqlite3.Row
            try:
                version = db.execute("PRAGMA user_version").fetchone()[0]
                if version not in {0, 1, 2, 3, 4, 5, 6}:
                    raise ProjectError("unsupported project store version")
                if write:
                    db.execute("BEGIN IMMEDIATE")
                    db.execute(
                        "CREATE TABLE IF NOT EXISTS projects ("
                        "id TEXT PRIMARY KEY, operation TEXT NOT NULL UNIQUE, "
                        "workspace TEXT NOT NULL UNIQUE, body TEXT NOT NULL, "
                        "snapshot TEXT NOT NULL, directories TEXT NOT NULL, "
                        "request TEXT NOT NULL)"
                    )
                    db.execute(
                        "CREATE TABLE IF NOT EXISTS research_revisions ("
                        "project_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, "
                        "reason TEXT NOT NULL, created_at TEXT NOT NULL, "
                        "PRIMARY KEY(project_id, revision))"
                    )
                    db.execute(
                        "CREATE TABLE IF NOT EXISTS research_heads ("
                        "project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, "
                        "accepted_revision INTEGER, published TEXT NOT NULL, pending TEXT)"
                    )
                    db.execute(
                        "CREATE TABLE IF NOT EXISTS research_confirmations ("
                        "project_id TEXT NOT NULL, revision INTEGER NOT NULL, "
                        "digest TEXT NOT NULL, "
                        "decision TEXT NOT NULL, created_at TEXT NOT NULL, "
                        "PRIMARY KEY(project_id, revision))"
                    )
                    db.execute(
                        "CREATE TABLE IF NOT EXISTS compiled_tasks ("
                        "project_id TEXT NOT NULL, experiment_id TEXT NOT NULL, "
                        "task_id TEXT NOT NULL, revision TEXT NOT NULL, body TEXT NOT NULL, "
                        "PRIMARY KEY(task_id, revision))"
                    )
                    db.execute(
                        "CREATE TABLE IF NOT EXISTS iteration_documents ("
                        "project_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, "
                        "body TEXT NOT NULL, PRIMARY KEY(project_id,kind,id))"
                    )
                    db.execute(
                        "CREATE TABLE IF NOT EXISTS codex_sessions ("
                        "thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, "
                        "started_at TEXT NOT NULL, cwd TEXT NOT NULL, "
                        "next_offset INTEGER NOT NULL DEFAULT 0, "
                        "next_line INTEGER NOT NULL DEFAULT 0, "
                        "FOREIGN KEY(project_id) REFERENCES projects(id))"
                    )
                    db.execute(
                        "CREATE TABLE IF NOT EXISTS agent_sessions ("
                        "provider TEXT NOT NULL, session_id TEXT NOT NULL, "
                        "project_id TEXT NOT NULL, "
                        "started_at TEXT NOT NULL, cwd TEXT NOT NULL, parent_session_id TEXT, "
                        "next_offset INTEGER NOT NULL DEFAULT 0, "
                        "next_line INTEGER NOT NULL DEFAULT 0, "
                        "prefix_digest TEXT, PRIMARY KEY(provider,session_id), "
                        "FOREIGN KEY(project_id) REFERENCES projects(id))"
                    )
                    if version < 6:
                        db.execute(
                            "INSERT OR IGNORE INTO agent_sessions "
                            "(provider,session_id,project_id,started_at,cwd,next_offset,next_line) "
                            "SELECT 'codex',thread_id,project_id,started_at,cwd,"
                            "next_offset,next_line "
                            "FROM codex_sessions"
                        )
                    db.execute(
                        "CREATE TABLE IF NOT EXISTS console_catalog ("
                        "source_id TEXT PRIMARY KEY, body TEXT NOT NULL)"
                    )
                    db.execute("PRAGMA user_version=6")
                elif version == 0:
                    if db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchone():
                        raise ProjectError("unrecognized project store schema")
                    # A crash before the very first transaction committed leaves an empty DB.
                    raise FileNotFoundError("project store initialization has not committed")
                yield db
                if write:
                    db.commit()
            finally:
                db.close()
