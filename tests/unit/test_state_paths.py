"""Shared configuration and Web/Controller startup order; no Docker or models."""

import json
import sqlite3

import pytest

from agent_infra.bootstrap.paths import prepare_controller_root, state_root
from agent_infra.bootstrap.projects import project_action
from agent_infra.bootstrap.research import project_runs, research_action
from agent_infra.bootstrap.settings import load_settings
from agent_infra.projects.analysis import AnalysisService
from agent_infra.projects.catalog import ProjectCatalogBridge
from agent_infra.projects.console import ProjectConsole
from agent_infra.records.local import LocalRecordsStore
from agent_infra.runs.control_store import RunControlStore
from agent_infra.runs.query import RunQueries
from tests.unit.projects.test_compilation import setup


def test_shared_default_explicit_environment_paths_and_no_state_creation(tmp_path, monkeypatch):
    monkeypatch.delenv("AGENT_INFRA_STATE_DIR", raising=False)
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "xdg"))
    expected = tmp_path / "xdg/agent-infra"
    assert state_root() == load_settings().state_dir == expected
    assert project_action("list", {})["state_dir"] == str(expected)
    assert not expected.exists()
    monkeypatch.setenv("AGENT_INFRA_STATE_DIR", str(tmp_path / "env"))
    assert state_root() == load_settings().state_dir == tmp_path / "env"
    assert state_root(str(tmp_path / "explicit")) == tmp_path / "explicit"
    linked = tmp_path / "linked"
    linked.symlink_to(tmp_path / "env", target_is_directory=True)
    with pytest.raises(ValueError, match="symlink"):
        state_root(str(linked))


def test_web_first_directory_is_accepted_without_relaxing_existing_permissions(tmp_path):
    state = tmp_path / "new-state"
    root = prepare_controller_root(state)
    LocalRecordsStore(root / "records")
    RunControlStore(root)
    assert root.stat().st_mode & 0o777 == 0o700
    assert prepare_controller_root(state) == root
    root.chmod(0o755)
    with pytest.raises(ValueError, match="0700"):
        prepare_controller_root(state)
    assert root.stat().st_mode & 0o777 == 0o755  # No silent repair of pre-existing state.


def test_context_consistent_across_cli_web_and_analysis_without_read_migration(tmp_path):
    compilation, project, _ = setup(tmp_path)
    store = compilation.store
    state = store.root.parent
    assert research_action(store, "context", {"identifier": project})["run_references"] == []
    assert not (state / "controller").exists()
    control = RunControlStore(prepare_controller_root(state))
    entry = control.create("operation", {"kind": "research"}, {"project_id": project})
    before = control.path.read_bytes()
    catalog = ProjectCatalogBridge(store, tmp_path / "console.sqlite3")
    web = ProjectConsole(store, catalog, run_references=lambda p: project_runs(state, p))
    analysis = AnalysisService(store, RunQueries(control, LocalRecordsStore(tmp_path / "records")))
    contexts = [
        research_action(store, "context", {"identifier": project}),
        web.detail(project, [])["research"],
        analysis.research.context(project),
    ]
    assert all(c["execution_links_supported"] for c in contexts)
    assert all(c["run_references"][0]["run_id"] == entry["run_id"] for c in contexts)
    assert control.path.read_bytes() == before
    reader = RunControlStore(control.path.parent, read_only=True)
    assert reader.get(entry["run_id"]) == json.loads(json.dumps(entry))
    with pytest.raises(sqlite3.OperationalError, match="readonly"):
        reader.update(entry["run_id"], state="finished")
