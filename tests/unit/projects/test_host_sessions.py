"""Anonymous recorded transcript shapes, migration and replay failure cases."""

import json
import sqlite3
from pathlib import Path
from uuid import uuid4

import pytest

from agent_infra.bootstrap.projects import project_action
from agent_infra.bootstrap.session_capture import session_action
from agent_infra.projects.local import LocalProjectStore
from agent_infra.projects.sessions import SessionBinding, SessionBindingStore
from agent_infra.records.api import EventQuery
from agent_infra.records.local import LocalRecordsStore


def setup_source(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    state = tmp_path / "state"
    project = project_action("attach", {"identifier": str(workspace), "state_dir": str(state)})[
        "project"
    ]
    home = tmp_path / "claude"
    directory = home / "projects" / "-workspace"
    directory.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(home))
    identifier = str(uuid4())
    path = directory / (identifier + ".jsonl")
    metadata = {"sessionId": identifier, "cwd": str(workspace), "timestamp": "2026-09-29T10:00:00Z"}
    options = {
        "identifier": project["project_id"],
        "state_dir": str(state),
        "provider": "claude-code",
    }
    return metadata, options, path


def write_rows(path, rows):
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))


def test_claude_parts_raw_archive_and_partial_line_replay(tmp_path, monkeypatch):
    meta, options, path = setup_source(tmp_path, monkeypatch)
    rows = [
        meta | {"type": "user", "message": {"content": "compare two methods"}},
        meta
        | {
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "text", "text": "run the experiment"},
                    {
                        "type": "tool_use",
                        "id": "call-1",
                        "name": "Bash",
                        "input": {"command": "python train.py"},
                    },
                ],
                "usage": {"input_tokens": 10, "output_tokens": 20},
            },
        },
        meta
        | {
            "type": "user",
            "message": {
                "content": [{"type": "tool_result", "tool_use_id": "call-1", "content": "loss=0.5"}]
            },
        },
    ]
    write_rows(path, rows)
    found = session_action("discover", options)["sessions"]
    assert len(found) == 1 and not found[0]["bound"]
    bound = session_action("bind", options | {"session_id": meta["sessionId"], "max_lines": "2"})
    assert bound["imported_lines"] == 2 and bound["has_more"]
    session_action("sync", options | {"session_id": meta["sessionId"]})
    records = LocalRecordsStore(Path(options["state_dir"]) / "controller/records")
    events = records.read_events(EventQuery(run_id=bound["records_run_id"])).items
    assert [event.event_type for event in events] == [
        "user.message",
        "agent.message",
        "tool.requested",
        "model.usage",
        "tool.completed",
    ]
    assert events[2].span_id == events[4].span_id
    assert events[3].payload["total_tokens"] == 30
    assert all(event.raw_refs and "native" not in event.payload for event in events)
    assert (
        session_action("sync", options | {"session_id": meta["sessionId"]})["imported_lines"] == 0
    )
    with path.open("ab") as stream:
        stream.write(b'{"type":"result"')
    assert (
        session_action("sync", options | {"session_id": meta["sessionId"]})["imported_lines"] == 0
    )
    with path.open("ab") as stream:
        stream.write(b',"subtype":"success"}\n')
    assert (
        session_action("sync", options | {"session_id": meta["sessionId"]})["imported_lines"] == 1
    )
    # Same-length replacement after the metadata line must not silently skip history.
    path.write_bytes(
        path.read_bytes().replace(b"run the experiment", b"run the experiment".upper())
    )
    with pytest.raises(ValueError, match="rewritten"):
        session_action("sync", options | {"session_id": meta["sessionId"]})


def test_claude_child_binding_is_separate_and_discovery_does_not_import(tmp_path, monkeypatch):
    meta, options, path = setup_source(tmp_path, monkeypatch)
    write_rows(path, [meta | {"type": "user", "message": {"content": "hello"}}])
    child = path.parent / meta["sessionId"] / "subagents" / "agent-child1.jsonl"
    child.parent.mkdir(parents=True)
    write_rows(
        child,
        [
            meta
            | {
                "type": "user",
                "isSidechain": True,
                "agentId": "child1",
                "message": {"content": "subtask"},
            }
        ],
    )
    found = session_action("discover", options)["sessions"]
    assert len(found) == 2
    assert not (Path(options["state_dir"]) / "controller/records").exists()
    identifier = meta["sessionId"] + ":child1"
    result = session_action("bind", options | {"session_id": identifier})
    assert result["parent_session_id"] == meta["sessionId"]
    assert len(session_action("list", options)["sessions"]) == 1
    other = tmp_path / "other"
    other.mkdir()
    wrong = project_action("attach", {"identifier": str(other), "state_dir": options["state_dir"]})[
        "project"
    ]
    with pytest.raises(ValueError, match="outside"):
        session_action(
            "bind", options | {"identifier": wrong["project_id"], "session_id": meta["sessionId"]}
        )


def test_v5_binding_cursor_migration_is_repeatable(tmp_path, monkeypatch):
    meta, options, _ = setup_source(tmp_path, monkeypatch)
    projects = LocalProjectStore(Path(options["state_dir"]) / "projects")
    with sqlite3.connect(projects.database.path) as db:
        db.execute("DROP TABLE agent_sessions")
        db.execute("PRAGMA user_version=5")
        db.execute(
            "INSERT INTO codex_sessions VALUES (?,?,?,?,?,?)",
            (meta["sessionId"], options["identifier"], meta["timestamp"], meta["cwd"], 123, 4),
        )
    store = SessionBindingStore(projects)
    before = store.get("codex", meta["sessionId"])
    assert before.next_offset == 123
    assert store.get("claude-code", meta["sessionId"]) is None
    assert store.list("") == ()
    assert store.list(options["identifier"]) == (before,)
    store.bind(
        SessionBinding(
            "claude-code", str(uuid4()), options["identifier"], meta["timestamp"], meta["cwd"]
        )
    )
    after = store.get("codex", meta["sessionId"])
    assert before == after
    store.advance(after, 123, 456, 8, "fingerprint")
    store.bind(
        SessionBinding(
            "claude-code", str(uuid4()), options["identifier"], meta["timestamp"], meta["cwd"]
        )
    )
    assert store.get("codex", meta["sessionId"]).next_offset == 456
