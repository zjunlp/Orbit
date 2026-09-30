"""Compose explicit project bindings, native transcript sources and Records capture."""

import hashlib
import json
import os
import stat
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from agent_infra.agents.codex_rollout import MAX_LINE
from agent_infra.agents.host_sessions import (
    discover_sessions,
    find_session,
    session_events,
    session_identity,
)
from agent_infra.bootstrap.paths import state_root
from agent_infra.projects.local import LocalProjectStore
from agent_infra.projects.service import ProjectService
from agent_infra.projects.sessions import SessionBinding, SessionBindingStore
from agent_infra.records.api import AttemptManifest, ProducerKind, RecordContext, RunManifest
from agent_infra.records.local import LocalRecordsStore


def session_action(action: str, options: dict[str, str]) -> dict[str, Any]:
    state = state_root(options.get("state_dir"))
    projects = LocalProjectStore(state / "projects")
    bindings = SessionBindingStore(projects)
    provider = options.get("provider", "codex")
    if action == "notify":
        notice = json.loads(options["notification"])
        if (
            provider != "codex"
            or not isinstance(notice, dict)
            or notice.get("type") != "agent-turn-complete"
        ):
            return {"status": "ignored"}
        try:
            identifier = session_identity(provider, str(notice.get("thread-id", "")))
        except ValueError:
            return {"status": "ignored"}
        binding = bindings.get(provider, identifier)
        cwd = notice.get("cwd")
        if (
            binding is None
            or not isinstance(cwd, str)
            or not Path(cwd)
            .resolve()
            .is_relative_to(Path(projects.get(binding.project_id).project.workspace).resolve())
        ):
            return {"status": "unbound_or_cwd_mismatch"}
        return _sync(state, bindings, binding, int(options.get("max_lines", "2000")))

    project = ProjectService(projects).get(options["identifier"])
    workspace = Path(project.workspace).resolve()
    if action == "list":
        return {
            "project_id": project.project_id,
            "sessions": [
                asdict(item)
                | {
                    "records_run_id": item.records_run_id,
                    "records_attempt_id": item.records_attempt_id,
                }
                for item in bindings.list(project.project_id)
                if item.provider == provider
            ],
        }
    if action == "discover":
        candidates = [
            {
                "provider": item.provider,
                "session_id": item.session_id,
                **({"thread_id": item.session_id} if provider == "codex" else {}),
                "parent_session_id": item.parent_session_id,
                "cwd": item.cwd,
                "started_at": item.started_at,
                "bound": bindings.get(provider, item.session_id) is not None,
            }
            for item in discover_sessions(provider)
            if Path(item.cwd).resolve().is_relative_to(workspace)
        ]
        candidates.sort(key=lambda item: str(item["started_at"]), reverse=True)
        return {
            "project_id": project.project_id,
            "sessions": candidates[:100],
            "truncated": len(candidates) > 100,
        }
    identifier = session_identity(provider, options.get("session_id", options.get("thread_id", "")))
    if action == "bind":
        session = find_session(provider, identifier)
        if not Path(session.cwd).resolve().is_relative_to(workspace):
            raise ValueError("Agent session cwd is outside the project workspace")
        binding = bindings.bind(
            SessionBinding(
                provider,
                identifier,
                project.project_id,
                session.started_at,
                session.cwd,
                session.parent_session_id,
            )
        )
    elif action == "sync":
        binding = bindings.get(provider, identifier)
        if binding is None or binding.project_id != project.project_id:
            raise ValueError("Agent session is not bound to this project")
    else:
        raise ValueError("unknown Agent session action")
    return _sync(state, bindings, binding, int(options.get("max_lines", "2000")))


def _sync(
    state: Path, bindings: SessionBindingStore, binding: SessionBinding, max_lines: int
) -> dict[str, Any]:
    if not 1 <= max_lines <= 10000:
        raise ValueError("max_lines must be between 1 and 10000")
    session = find_session(binding.provider, binding.session_id)
    if (session.cwd, session.started_at, session.parent_session_id) != (
        binding.cwd,
        binding.started_at,
        binding.parent_session_id,
    ):
        raise ValueError("Agent session metadata changed; capture stopped")
    records = LocalRecordsStore(state / "controller" / "records")
    started = datetime.fromisoformat(binding.started_at)
    # Keep the exact immutable Codex manifest used by earlier versions.
    request: dict[str, Any] = {
        "kind": "host_codex_session" if binding.provider == "codex" else "host_agent_session",
        "project_id": binding.project_id,
    }
    if binding.provider != "codex":
        request.update(
            provider=binding.provider,
            session_id=binding.session_id,
            parent_session_id=binding.parent_session_id,
        )
    records.begin_run(RunManifest(binding.records_run_id, started, request))
    records.begin_attempt(
        AttemptManifest(
            binding.records_attempt_id,
            binding.records_run_id,
            started,
            coverage={"host_agent": "partial", "host_external_actions": "unavailable"},
        )
    )
    sink = records.scoped_sink(
        RecordContext(
            binding.records_run_id,
            binding.records_attempt_id,
            f"host-{binding.provider}:{binding.session_id}",
            ProducerKind.AGENT,
            session_id=binding.session_id,
        )
    )
    offset, line = binding.next_offset, binding.next_line
    imported, bytes_read = 0, 0
    descriptor = os.open(session.path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_nlink != 1
            or session.path.resolve() != session.path
        ):
            raise ValueError("native transcript is not an owned regular file")
        if info.st_size < offset:
            raise ValueError("Agent session was truncated; capture stopped")
        digest = hashlib.sha256()
        remaining = offset
        while remaining:
            chunk = stream.read(min(1024**2, remaining))
            if not chunk:
                raise ValueError("Agent session was truncated during capture")
            digest.update(chunk)
            remaining -= len(chunk)
        if binding.prefix_digest is not None and digest.hexdigest() != binding.prefix_digest:
            raise ValueError("previously captured transcript was rewritten; capture stopped")
        while imported < max_lines and bytes_read < 32 * 1024**2:
            raw = stream.readline(MAX_LINE + 1)
            if len(raw) > MAX_LINE:
                raise ValueError("Agent session line exceeds 16 MiB capture limit")
            if not raw or not raw.endswith(b"\n"):
                break
            try:
                row = json.loads(raw)
            except (UnicodeError, ValueError):
                row = {"type": "invalid_json"}
            if not isinstance(row, dict):
                row = {"type": "invalid_json"}
            blob = sink.put_blob(raw, media_type="application/x-ndjson")
            sink.append_events(session_events(session, row, line, blob.digest))
            digest.update(raw)
            previous, offset, line = offset, stream.tell(), line + 1
            bindings.advance(binding, previous, offset, line, digest.hexdigest())
            imported += 1
            bytes_read += len(raw)
        # Also establish a fingerprint for migrated cursors with no new lines.
        if not imported and binding.prefix_digest is None:
            bindings.advance(binding, offset, offset, line, digest.hexdigest())
        stream.seek(0, 2)
        has_more = stream.tell() > offset
    return {
        "project_id": binding.project_id,
        "provider": binding.provider,
        "session_id": binding.session_id,
        **({"thread_id": binding.session_id} if binding.provider == "codex" else {}),
        "parent_session_id": binding.parent_session_id,
        "records_run_id": binding.records_run_id,
        "records_attempt_id": binding.records_attempt_id,
        "imported_lines": imported,
        "next_line": line,
        "has_more": has_more,
        "capture_status": "partial",
        "synced_at": datetime.now(UTC).isoformat(),
    }
