"""Native host transcript sources; discovery never implies permission to import."""

import hashlib
import json
import os
import re
import stat
from collections.abc import Iterator
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from agent_infra.agents.claude_code import ClaudeCodeAdapter
from agent_infra.agents.codex_rollout import MAX_LINE, find_sessions, rollout_event
from agent_infra.agents.recording import agent_event_draft
from agent_infra.records.api import CaptureStatus, DataClass, EventDraft, Visibility

PROVIDERS = ("codex", "claude-code")


@dataclass(frozen=True)
class HostSession:
    provider: str
    session_id: str
    cwd: str
    started_at: str
    path: Path
    parent_session_id: str | None = None


def session_identity(provider: str, identifier: str) -> str:
    if provider not in PROVIDERS:
        raise ValueError("unsupported host session provider")
    parent, separator, child = identifier.partition(":")
    parent = str(UUID(parent))
    if separator and (provider != "claude-code" or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", child)):
        raise ValueError("invalid subagent identity")
    return parent + separator + child


def _claude_metadata(path: Path, root: Path) -> HostSession | None:
    try:
        info = path.stat(follow_symlinks=False)
        if (
            path.resolve() != path
            or not path.is_relative_to(root)
            or not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_nlink != 1
        ):
            return None
        with path.open("rb") as stream:
            # Some transcripts start with snapshot/progress metadata rather than a message.
            for _ in range(128):
                raw = stream.readline(MAX_LINE + 1)
                if not raw or len(raw) > MAX_LINE:
                    return None
                row = json.loads(raw)
                if not isinstance(row, dict) or not all(
                    isinstance(row.get(k), str) for k in ("sessionId", "cwd", "timestamp")
                ):
                    continue
                started = datetime.fromisoformat(row["timestamp"])
                if not started.tzinfo or not Path(row["cwd"]).is_absolute():
                    return None
                parent = str(UUID(row["sessionId"]))
                child = row.get("agentId") if row.get("isSidechain") else None
                if "subagents" in path.relative_to(root).parts and not child:
                    return None
                identifier = session_identity(
                    "claude-code", parent + (":" + str(child) if child else "")
                )
                return HostSession(
                    "claude-code",
                    identifier,
                    row["cwd"],
                    started.isoformat(),
                    path,
                    parent if child else None,
                )
    except (OSError, ValueError, TypeError):
        return None
    return None


def discover_sessions(provider: str) -> Iterator[HostSession]:
    if provider == "codex":
        for item in find_sessions():
            yield HostSession(provider, item.thread_id, item.cwd, item.started_at, item.path)
    elif provider == "claude-code":
        root = (
            Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude"))).expanduser()
            / "projects"
        ).resolve()
        if not root.is_dir():
            return
        for path in sorted(root.rglob("*.jsonl")):
            candidate = _claude_metadata(path, root)
            if candidate:
                yield candidate
    else:
        raise ValueError("unsupported host session provider")


def find_session(provider: str, identifier: str) -> HostSession:
    identity = session_identity(provider, identifier)
    matches = [item for item in discover_sessions(provider) if item.session_id == identity]
    if len(matches) != 1:
        raise ValueError("native session is missing or has ambiguous copies")
    return matches[0]


def session_events(
    session: HostSession, row: dict[str, Any], line: int, digest: str
) -> tuple[EventDraft, ...]:
    if session.provider == "codex":
        # Preserve established IDs, sequence numbers and normalization on replay.
        return (rollout_event(row, line, digest, session.session_id),)
    normalized = dict(row)
    message = row.get("message")
    if isinstance(message, dict) and isinstance(message.get("usage"), dict):
        normalized["usage"] = message["usage"]
    events = list(ClaudeCodeAdapter().decode_events(iter([json.dumps(normalized)])))
    if len(events) > 256:
        raise ValueError("Claude native line has more than 256 event parts")
    result = []
    observed = None
    try:
        parsed = datetime.fromisoformat(str(row.get("timestamp", "")))
        observed = parsed if parsed.tzinfo else None
    except ValueError:
        pass
    for part, event in enumerate(events):
        payload: dict[str, Any] = dict(event.canonical)
        for key in ("text", "arguments", "result"):
            value = payload.get(key)
            if value is not None:
                text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
                if len(text) > 16384:
                    payload[key], payload[key + "_truncated"] = text[:16384], True
        payload.update(source_line=line, part_index=part, native_type=event.native_type)
        call_id = payload.get("tool_call_id")
        draft = agent_event_draft(event, (digest,))
        event_type = draft.event_type
        if event_type == "agent.message" and payload.get("role") == "user":
            event_type = "user.message"
        result.append(
            replace(
                draft,
                event_type=event_type,
                payload=payload,
                producer_sequence=line * 256 + part,
                idempotency_key=f"claude-rollout:{session.session_id}:{line}:{part}",
                observed_at=observed,
                correlation={
                    "source": "claude-interactive",
                    **({"tool_call_id": str(call_id)} if call_id else {}),
                },
                span_id="claude_tool_" + hashlib.sha256(str(call_id).encode()).hexdigest()[:24]
                if call_id
                else None,
                raw_refs=(digest,),
                visibility=Visibility.CONTROLLER
                if event_type == "agent.native_event"
                else Visibility.USER,
                data_class=DataClass.USER_PRIVATE,
                capture_status=CaptureStatus.PARTIAL,
                normalizer_name="claude-interactive-rollout",
                normalizer_version="1.0.0",
            )
        )
    return tuple(result)
