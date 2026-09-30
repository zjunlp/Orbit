"""Read local interactive Codex rollouts without treating them as exec --json streams."""

from __future__ import annotations

import hashlib
import json
import os
import stat
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from agent_infra.records.api import CaptureStatus, DataClass, EventDraft, Visibility

MAX_LINE = 16 * 1024 * 1024


@dataclass(frozen=True)
class CodexSession:
    thread_id: str
    cwd: str
    started_at: str
    path: Path


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().resolve()


def _private_file(path: Path, home: Path) -> bool:
    try:
        if not any(path.is_relative_to(home / name) for name in ("sessions", "archived_sessions")):
            return False
        if path.is_symlink() or path.resolve() != path:
            return False
        info = path.stat(follow_symlinks=False)
        return stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
    except OSError:
        return False


def session_metadata(path: Path, home: Path) -> CodexSession | None:
    if not _private_file(path, home):
        return None
    try:
        with path.open("rb") as stream:
            first = stream.readline(MAX_LINE + 1)
        if len(first) > MAX_LINE or not first.endswith(b"\n"):
            return None
        row = json.loads(first)
        if row.get("type") != "session_meta" or not isinstance(row.get("payload"), dict):
            return None
        payload = row["payload"]
        thread_id = str(UUID(payload["id"]))
        cwd = payload["cwd"]
        started = payload["timestamp"]
        if not isinstance(cwd, str) or not Path(cwd).is_absolute():
            return None
        if not isinstance(started, str) or datetime.fromisoformat(started).tzinfo is None:
            return None
        return CodexSession(thread_id, cwd, started, path)
    except (OSError, ValueError, TypeError, KeyError, UnicodeError):
        return None


def find_sessions(home: Path | None = None) -> Iterator[CodexSession]:
    root = home or codex_home()
    for directory in (root / "sessions", root / "archived_sessions"):
        if not directory.is_dir() or directory.is_symlink():
            continue
        for path in directory.rglob("*.jsonl"):
            metadata = session_metadata(path, root)
            if metadata is not None:
                yield metadata


def rollout_event(
    row: dict[str, Any], line_number: int, raw_digest: str, thread_id: str
) -> EventDraft:
    """Produce bounded user-visible facts; keep full native JSON in the private blob."""
    outer_type = row.get("type")
    payload = row.get("payload")
    value = payload if isinstance(payload, dict) else {}
    inner_type = value.get("type")
    body: dict[str, object] = {"source_line": line_number, "native_type": str(outer_type)}
    visible = Visibility.CONTROLLER
    event_type = "agent.native_event"
    if outer_type == "session_meta":
        event_type = "agent.session_started"
        body["session_id"] = str(value.get("id", ""))
        visible = Visibility.USER
    elif outer_type == "response_item":
        if inner_type == "message":
            role = value.get("role")
            if role in {"assistant", "user"}:
                event_type = "agent.message" if role == "assistant" else "user.message"
                body["role"] = role
                parts = value.get("content")
                if isinstance(parts, list):
                    message = "\n".join(
                        str(part["text"])
                        for part in parts
                        if isinstance(part, dict) and isinstance(part.get("text"), str)
                    )
                    body["text"] = message[:16384]
                    body["text_truncated"] = len(message) > 16384
                visible = Visibility.USER
        elif inner_type in {"custom_tool_call", "function_call"}:
            event_type = "tool.requested"
            body.update(
                tool_name=str(value.get("name", "")),
                tool_call_id=str(value.get("call_id", "")),
            )
            arguments = value.get("input", value.get("arguments"))
            if isinstance(arguments, str):
                body["arguments"] = arguments[:16384]
                body["arguments_truncated"] = len(arguments) > 16384
            visible = Visibility.USER
        elif inner_type in {"custom_tool_call_output", "function_call_output"}:
            event_type = "tool.completed"
            body["tool_call_id"] = str(value.get("call_id", ""))
            output = value.get("output")
            if isinstance(output, str):
                body["result"] = output[:16384]
                body["result_truncated"] = len(output) > 16384
            visible = Visibility.USER
    elif outer_type == "event_msg":
        if inner_type in {"task_complete", "turn_aborted"}:
            event_type = "agent.turn_completed" if inner_type == "task_complete" else "agent.error"
            body["status"] = "completed" if inner_type == "task_complete" else "aborted"
            visible = Visibility.USER
    elif outer_type == "token_usage_record":
        event_type = "model.usage"
        usage = value.get("usage")
        if isinstance(usage, dict):
            body["usage"] = {
                key: number
                for key, number in usage.items()
                if key
                in {
                    "input_tokens",
                    "cached_input_tokens",
                    "output_tokens",
                    "reasoning_output_tokens",
                    "total_tokens",
                }
                and type(number) is int
            }
        visible = Visibility.USER
    timestamp = row.get("timestamp")
    observed = None
    if isinstance(timestamp, str):
        try:
            parsed = datetime.fromisoformat(timestamp)
            observed = parsed if parsed.tzinfo else None
        except ValueError:
            pass
    return EventDraft(
        event_type,
        body,
        producer_sequence=line_number,
        idempotency_key=f"codex-rollout:{thread_id}:{line_number}",
        observed_at=observed,
        correlation={
            "source": "codex-interactive",
            **({"tool_call_id": str(body["tool_call_id"])} if body.get("tool_call_id") else {}),
        },
        span_id=(
            "codex_tool_" + hashlib.sha256(str(body["tool_call_id"]).encode()).hexdigest()[:24]
            if body.get("tool_call_id")
            else None
        ),
        raw_refs=(raw_digest,),
        visibility=visible,
        data_class=DataClass.USER_PRIVATE,
        capture_status=CaptureStatus.PARTIAL,
        normalizer_name="codex-interactive-rollout",
        normalizer_version="1.0.0",
    )
