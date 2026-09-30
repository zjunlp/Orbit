"""C01–C03 using real SQLite, material copies, public Tasks consumers and CLI."""

import json
import os
import sqlite3
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from agent_infra.projects import InitRequest, ProjectConflict, ResearchDraft
from agent_infra.projects.compiler import CompilationService
from agent_infra.projects.local import LocalProjectStore
from agent_infra.projects.relocation import rebind_project
from agent_infra.projects.research import ResearchService
from agent_infra.projects.service import ProjectService
from agent_infra.tasks import (
    build_agent_view,
    freeze_task,
    load_task,
    materialize_agent_view,
    review_draft,
)

EXECUTION = (
    "environment:\n  state: specified\n  image: python:3.12-slim\n"
    "tools:\n  state: none\nevaluation:\n  state: none\n"
)


def setup(root: Path, *, confirmed: bool = True) -> tuple[CompilationService, str, Path]:
    store = LocalProjectStore(root / "state/projects")
    project = ProjectService(store).initialize(
        InitRequest("比较两个统计方法", directory=root / "project")
    )
    workspace = Path(project.workspace)
    (workspace / "code/src/train.py").write_text("print('small fixture')\n")
    (workspace / "data/raw/input.csv").write_text("value\n1\n2\n3\n")
    (workspace / "private.txt").write_text("not selected; must not be copied")
    (workspace / "configs/resources/pilot.yaml").write_text(
        "version: 1\nrequest_id: pilot\nresources:\n  cpu: 1\n  memory: 1GiB\n"
    )
    (workspace / "configs/experiments/pilot.yaml").write_text(EXECUTION)
    draft = ResearchDraft.from_dict(
        {
            "schema_version": 1,
            "brief": {"question": "比较两个统计方法"},
            "plan": {
                "experiments": [
                    {
                        "id": "pilot",
                        "method": "读取数据，比较均值与中位数",
                        "stopping_condition": "生成对比报告后结束",
                        "inputs": [
                            {"path": "code/src", "version": "v1"},
                            {"path": "data/raw/input.csv", "version": "v1"},
                        ],
                        "outputs": ["artifacts/report.json"],
                        "resource_request": "configs/resources/pilot.yaml",
                    }
                ]
            },
        }
    )
    research = ResearchService(store)
    saved = research.save(project.project_id, draft, expected_revision=0, reason="fixture")
    if confirmed:
        research.confirm(
            project.project_id,
            revision=1,
            digest=saved["research"]["digest"],
            decision="fixture adoption",
        )
    return CompilationService(store), project.project_id, workspace


def compile(service: CompilationService, identifier: str, revision: int = 1) -> dict:
    return service.compile(
        identifier,
        experiment_id="pilot",
        research_revision=revision,
        execution="configs/experiments/pilot.yaml",
    )


def test_public_consumers_and_frozen_materials(tmp_path: Path) -> None:
    service, identifier, workspace = setup(tmp_path)
    result = compile(service, identifier)
    assert result["status"] == "compiled", result
    task = load_task(Path(result["manifest"]))
    assert review_draft(task).status == "ready"
    snapshot = freeze_task(task)
    view = build_agent_view(task)
    assert {m.path for m in view.materials} == {
        ".agent-infra/instruction.md",
        "code/src",
        "data/raw/input.csv",
    }
    materialize_agent_view(task, snapshot, tmp_path / "solver")
    assert not (tmp_path / "solver/control").exists()
    assert not (tmp_path / "solver/private.txt").exists()
    assert (tmp_path / "solver/code/src/train.py").read_text() == "print('small fixture')\n"
    first = result["compiled"]
    assert compile(service, identifier)["compiled"] == first
    assert len(service.list(identifier)["compiled_tasks"]) == 1
    assert ResearchService(service.store).context(identifier)["compiled_tasks"][0] == first
    source = json.loads(task.source_json)
    assert source["project_id"] == identifier and source["research_revision"] == 1
    assert task.evaluation.state == "none"
    # Live source changes yield a new content revision, never modify the previous Task.
    (workspace / "code/src/train.py").write_text("print('changed')\n")
    second = compile(service, identifier)["compiled"]
    assert second["task"]["task_id"] == first["task"]["task_id"]
    assert second["task"]["revision"] != first["task"]["revision"]
    assert freeze_task(task) == snapshot
    assert (task.root / "inputs/0/train.py").read_text() == "print('small fixture')\n"
    assert (
        os.stat(task.root / "inputs/0/train.py").st_ino
        != os.stat(workspace / "code/src/train.py").st_ino
    )
    assert len(service.list(identifier)["compiled_tasks"]) == 2
    assert len(service.list(identifier, limit=1, offset=1)["compiled_tasks"]) == 1


def test_confirmed_revision_and_plan_changes(tmp_path: Path) -> None:
    service, identifier, _ = setup(tmp_path, confirmed=False)
    assert compile(service, identifier)["status"] == "needs_input"
    assert service.list(identifier)["compiled_tasks"] == []
    research = ResearchService(service.store)
    original = research.show(identifier)["research"]
    research.confirm(identifier, revision=1, digest=original["digest"], decision="adopt")
    first = compile(service, identifier)
    doc = original["document"]
    doc["plan"]["experiments"][0]["method"] = "只比较均值和中位数"
    newer = research.save(
        identifier, ResearchDraft.from_dict(doc), expected_revision=1, reason="user correction"
    )
    assert compile(service, identifier, 2)["status"] == "needs_input"
    assert compile(service, identifier)["compiled"] == first["compiled"]
    research.confirm(
        identifier, revision=2, digest=newer["research"]["digest"], decision="adopt correction"
    )
    second = compile(service, identifier, 2)
    assert second["compiled"]["research_revision"] == 2
    assert second["compiled"]["task"]["revision"] != first["compiled"]["task"]["revision"]
    ref = first["compiled"]["task"]
    assert service.resolve(ref["task_id"], ref["revision"])["compiled"] == first["compiled"]


@pytest.mark.parametrize(
    "problem",
    [
        "missing",
        "symlink",
        "fifo",
        "hardlink",
        "invalid-resource",
        "unknown-tools",
        "missing-image",
        "evaluation",
        "unknown-policy",
        "budget",
    ],
)
def test_invalid_materials_and_settings_never_publish(tmp_path: Path, problem: str) -> None:
    service, identifier, workspace = setup(tmp_path)
    data = workspace / "data/raw/input.csv"
    settings = workspace / "configs/experiments/pilot.yaml"
    if problem in {"missing", "symlink", "fifo", "hardlink"}:
        data.unlink()
        if problem == "symlink":
            data.symlink_to(workspace / "private.txt")
        elif problem == "fifo":
            os.mkfifo(data)
        elif problem == "hardlink":
            os.link(workspace / "private.txt", data)
    elif problem == "invalid-resource":
        (workspace / "configs/resources/pilot.yaml").write_text("resources: {}")
    elif problem == "unknown-tools":
        settings.write_text(EXECUTION.replace("tools:\n  state: none", "tools:\n  state: unknown"))
    elif problem == "missing-image":
        settings.write_text(EXECUTION.replace("  image: python:3.12-slim\n", ""))
    elif problem == "evaluation":
        settings.write_text(
            EXECUTION.replace("evaluation:\n  state: none", "evaluation:\n  state: unknown")
        )
    elif problem == "unknown-policy":
        settings.write_text(EXECUTION + "execution_policy:\n  state: unknown\n")
    result = service.compile(
        identifier,
        experiment_id="pilot",
        research_revision=1,
        execution="configs/experiments/pilot.yaml",
        max_material_bytes=1 if problem == "budget" else 1024**2,
    )
    assert result["status"] == "needs_input", result
    assert service.list(identifier)["compiled_tasks"] == []
    assert list((service.store.root / "tasks").iterdir()) == []


def test_unknown_data_and_overlapping_paths_block(tmp_path: Path) -> None:
    service, identifier, _ = setup(tmp_path)
    research = ResearchService(service.store)
    doc = research.context(identifier)["document"]
    doc["brief"]["unknowns"] = ["数据待定"]
    saved = research.save(
        identifier, ResearchDraft.from_dict(doc), expected_revision=1, reason="unknown"
    )
    research.confirm(
        identifier, revision=2, digest=saved["research"]["digest"], decision="planning only"
    )
    result = compile(service, identifier, 2)
    assert result["issues"][0]["message"] == "数据待定"
    assert not (service.store.root / "tasks").exists()
    doc["brief"]["unknowns"] = []
    doc["plan"]["experiments"][0]["outputs"] = ["code/src/output.txt"]
    saved = research.save(
        identifier, ResearchDraft.from_dict(doc), expected_revision=2, reason="overlap"
    )
    research.confirm(
        identifier, revision=3, digest=saved["research"]["digest"], decision="test overlap"
    )
    assert "overlap" in compile(service, identifier, 3)["issues"][0]["message"]


def test_tampered_bundle_is_never_overwritten(tmp_path: Path) -> None:
    service, identifier, _ = setup(tmp_path)
    result = compile(service, identifier)
    root = Path(result["manifest"]).parent
    (root / "instruction.md").write_text("user changed")
    ref = result["compiled"]["task"]
    with pytest.raises(ProjectConflict, match="bundle changed"):
        service.resolve(ref["task_id"], ref["revision"])
    with pytest.raises(ProjectConflict, match="bundle changed"):
        compile(service, identifier)
    assert (root / "instruction.md").read_text() == "user changed"


def test_source_change_during_preparation_is_not_published(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agent_infra.projects import _preparation

    service, identifier, workspace = setup(tmp_path)
    original = _preparation.copy_material

    def racing(*args: object, **kwargs: object) -> None:
        original(*args, **kwargs)
        (workspace / "code/src/train.py").write_text("changed during preparation")

    monkeypatch.setattr(_preparation, "copy_material", racing)
    with pytest.raises(ProjectConflict, match="changed during preparation"):
        compile(service, identifier)
    assert service.list(identifier)["compiled_tasks"] == []


def test_required_tools_are_preserved_without_claiming_binding(tmp_path: Path) -> None:
    service, identifier, workspace = setup(tmp_path)
    (workspace / "configs/experiments/pilot.yaml").write_text(
        EXECUTION.replace(
            "tools:\n  state: none",
            "tools:\n  state: specified\n  items:\n"
            "    - tool_id: search\n      version: v1\n      required: true\n"
            "      transport: mcp\n      scope: research",
        )
    )
    result = compile(service, identifier)
    assert result["execution_validated"] is False
    tool = build_agent_view(load_task(Path(result["manifest"]))).tools[0]
    assert tool.tool_id == "search" and tool.required and tool.transport == "mcp"


CHILD = """
import os, sys
from pathlib import Path
from agent_infra.projects.compiler import CompilationService
from agent_infra.projects.local import LocalProjectStore
service = CompilationService(LocalProjectStore(Path(sys.argv[1]) / 'state/projects'))
if sys.argv[3] == 'published':
    def crash(*args): os._exit(73)
    service.links.save = crash
result = service.compile(sys.argv[2], experiment_id='pilot', research_revision=1,
                         execution='configs/experiments/pilot.yaml')
assert result['status'] == 'compiled', result
"""


def test_process_death_after_publish_and_concurrent_retries(tmp_path: Path) -> None:
    service, identifier, _ = setup(tmp_path)

    def run(phase: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-c", CHILD, str(tmp_path), identifier, phase],
            capture_output=True,
            text=True,
            timeout=30,
        )

    assert run("published").returncode == 73
    assert service.list(identifier)["compiled_tasks"] == []
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(run, ["normal", "normal"]))
    assert all(r.returncode == 0 for r in results), [r.stderr for r in results]
    links = service.list(identifier)["compiled_tasks"]
    assert len(links) == 1
    ref = links[0]["task"]
    service.resolve(ref["task_id"], ref["revision"])


def test_move_workspace_keeps_identity_plans_and_tasks(tmp_path: Path) -> None:
    service, identifier, workspace = setup(tmp_path)
    first = compile(service, identifier)
    moved = tmp_path / "moved"
    workspace.rename(moved)
    rebound = rebind_project(service.store, identifier, moved, expected_revision=1)
    assert rebound.project_id == identifier and rebound.revision == 2
    assert service.projects.get(str(moved)).project_id == identifier
    assert rebind_project(service.store, identifier, moved, expected_revision=1) == rebound
    assert service.projects.projection_matches(rebound)
    assert compile(service, identifier)["compiled"] == first["compiled"]
    assert ResearchService(service.store).context(str(moved))["accepted_revision"] == 1
    ref = first["compiled"]["task"]
    assert service.resolve(ref["task_id"], ref["revision"])["manifest"] == first["manifest"]


def test_rebind_rejects_existing_old_workspace_and_modified_identity(tmp_path: Path) -> None:
    service, identifier, workspace = setup(tmp_path)
    with pytest.raises(ProjectConflict, match="still exists"):
        rebind_project(service.store, identifier, tmp_path / "another", expected_revision=1)
    moved = tmp_path / "moved"
    workspace.rename(moved)
    (moved / "project.yaml").write_text("project_id: invented")
    with pytest.raises(ProjectConflict, match="manifest differs"):
        rebind_project(service.store, identifier, moved, expected_revision=1)
    assert service.store.get(identifier).project.workspace == str(workspace)


def test_rebind_commit_interruption_recovers(tmp_path: Path) -> None:
    service, identifier, workspace = setup(tmp_path)
    moved = tmp_path / "moved"
    workspace.rename(moved)
    child = """
import os, sys
from pathlib import Path
from agent_infra.projects.local import LocalProjectStore
from agent_infra.projects.service import ProjectService
from agent_infra.projects.relocation import rebind_project
def crash(*args): os._exit(74)
ProjectService._recover = crash
rebind_project(LocalProjectStore(Path(sys.argv[1]) / 'state/projects'), sys.argv[2],
               Path(sys.argv[1]) / 'moved', expected_revision=1)
"""
    result = subprocess.run([sys.executable, "-c", child, str(tmp_path), identifier], timeout=20)
    assert result.returncode == 74
    recovered = service.projects.recover(identifier)
    assert recovered.workspace == str(moved) and recovered.revision == 2
    assert service.projects.projection_matches(recovered)
    assert compile(service, identifier)["status"] == "compiled"


def test_schema_two_read_and_upgrade_and_unchanged_research_digest(tmp_path: Path) -> None:
    service, identifier, _ = setup(tmp_path)
    research = ResearchService(service.store)
    digest = research.context(identifier)["digest"]
    with sqlite3.connect(service.store.path) as db:
        db.execute("DROP TABLE compiled_tasks")
        db.execute("PRAGMA user_version=2")
    assert service.list(identifier)["compiled_tasks"] == []
    assert research.context(identifier)["digest"] == digest
    with sqlite3.connect(service.store.path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 2
    assert compile(service, identifier)["status"] == "compiled"
    with sqlite3.connect(service.store.path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 6
    assert research.context(identifier)["digest"] == digest


def test_real_cli_compile_lookup_and_missing_input_exit_code(tmp_path: Path) -> None:
    service, identifier, workspace = setup(tmp_path)

    def cli(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["agent-infra", "project", *args, "--state-dir", str(tmp_path / "state")],
            cwd="/tmp",
            text=True,
            capture_output=True,
            timeout=20,
        )

    missing = cli("compile", identifier, "--experiment", "pilot", "--revision", "1")
    assert missing.returncode == 1 and json.loads(missing.stdout)["status"] == "needs_input"
    result = cli(
        "compile",
        identifier,
        "--experiment",
        "pilot",
        "--revision",
        "1",
        "--execution",
        "configs/experiments/pilot.yaml",
    )
    assert result.returncode == 0, result.stderr
    ref = json.loads(result.stdout)["compiled"]["task"]
    resolved = cli("resolve-task", ref["task_id"], "--task-revision", ref["revision"])
    assert resolved.returncode == 0, resolved.stderr
    assert cli("compiled-tasks", str(workspace)).returncode == 0
    moved = tmp_path / "moved"
    workspace.rename(moved)
    rebound = cli("rebind", identifier, "--directory", str(moved), "--expected-revision", "1")
    assert rebound.returncode == 0, rebound.stderr
