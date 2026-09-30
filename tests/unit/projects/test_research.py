"""Research revisions, decision binding, recovery and real CLI/skill behavior."""

import json
import sqlite3
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest

from agent_infra.projects import InitRequest, ProjectConflict, ProjectError, ResearchDraft
from agent_infra.projects.local import LocalProjectStore
from agent_infra.projects.research import ResearchService
from agent_infra.projects.service import ProjectService


def setup(root: Path) -> tuple[ResearchService, str]:
    store = LocalProjectStore(root / "state/projects")
    project = ProjectService(store).initialize(
        InitRequest("原始研究目标，不可改写", directory=root / "research")
    )
    return ResearchService(store), project.project_id


def draft(question: str = "比较两种位置编码") -> ResearchDraft:
    return ResearchDraft.from_dict(
        {
            "schema_version": 1,
            "brief": {
                "question": question,
                "constraints": ["最多一张 GPU"],
                "unknowns": ["数据待定"],
            },
            "plan": {
                "summary": "先做小实验",
                "experiments": [
                    {
                        "id": "pilot",
                        "method": "保持数据相同，比较方法 A 和 B",
                        "outputs": ["artifacts/comparison.md"],
                        "stopping_condition": "达到约定时间后停止",
                    }
                ],
            },
            "claims": [
                {"text": "最多一张 GPU", "origin": "user"},
                {"text": "小实验可暴露差异", "origin": "assumption"},
            ],
            "next_step": "选择数据",
        }
    )


def test_incomplete_draft_canonical_roundtrip_and_original_goal(tmp_path: Path) -> None:
    service, identifier = setup(tmp_path)
    empty = ResearchDraft.from_dict({"schema_version": 1})
    result = service.save(identifier, empty, expected_revision=0, reason="保存未完善草稿")
    assert result["projection"]["status"] == "ready"
    fresh = ResearchService(LocalProjectStore(service.store.root))
    context = fresh.context(identifier)
    assert context["research_revision"] == 1
    assert context["project"]["original_goal"] == "原始研究目标，不可改写"
    assert context["project"]["revision"] == 1
    assert context["accepted_revision"] is None
    assert fresh.check(identifier)["issues"]
    assert fresh.check(identifier)["execution_validated"] is False
    assert ResearchDraft.from_dict(empty.to_dict()) == empty
    mutable = empty.to_dict()
    mutable["brief"]["question"] = "修改副本"
    assert empty.to_dict()["brief"]["question"] == ""


@pytest.mark.parametrize(
    "patch",
    [
        {"schema_version": True},
        {"schema_version": 2},
        {"original_goal": "overwrite"},
        {"brief": {"question": []}},
        {"claims": [{"text": "claim", "origin": "sourced"}]},
        {"claims": [{"text": "claim", "origin": "verified"}]},
        {"claims": [{"text": "claim", "origin": "sourced", "references": ["../answer"]}]},
        {"plan": {"experiments": [{"id": "a"}, {"id": "a"}]}},
        {"plan": {"experiments": [{"id": "../a"}]}},
        {"plan": {"experiments": [{"id": "a", "inputs": [{"path": "/private"}]}]}},
        {"plan": {"experiments": [{"id": "a", "outputs": ["../../outside"]}]}},
        {
            "plan": {
                "experiments": [{"id": "a", "metrics": [{"name": "loss", "direction": "maybe"}]}]
            }
        },
    ],
)
def test_draft_rejects_malformed_content(patch: dict[str, Any]) -> None:
    with pytest.raises(ProjectError):
        ResearchDraft.from_dict({"schema_version": 1} | patch)


def test_revision_history_diff_and_exact_confirmation(tmp_path: Path) -> None:
    service, identifier = setup(tmp_path)
    first = service.save(identifier, draft(), expected_revision=0, reason="初稿")["research"]
    chosen = service.confirm(
        identifier, revision=1, digest=first["digest"], decision="用户采用初稿，暂不运行"
    )
    assert (
        service.confirm(
            identifier, revision=1, digest=first["digest"], decision="用户采用初稿，暂不运行"
        )
        == chosen
    )
    second = service.save(
        identifier, draft("仅在一个数据集比较"), expected_revision=1, reason="用户缩小范围"
    )["research"]
    ctx = service.context(identifier)
    assert ctx["research_revision"] == 2 and ctx["accepted_revision"] == 1
    assert ctx["unaccepted_changes"] is True
    assert service.show(identifier, 1)["research"] == first
    assert [r["revision"] for r in service.history(identifier, before=2)] == [1]
    assert "仅在一个数据集比较" in service.diff(identifier, 1, 2)["diff"]
    assert (
        service.save(
            identifier, draft("仅在一个数据集比较"), expected_revision=1, reason="用户缩小范围"
        )["research"]
        == second
    )
    with pytest.raises(ProjectConflict):
        service.confirm(identifier, revision=1, digest=first["digest"], decision="stale")
    with pytest.raises(ProjectConflict):
        service.confirm(identifier, revision=2, digest=first["digest"], decision="wrong content")
    service.confirm(identifier, revision=2, digest=second["digest"], decision="用户采用新版")
    assert service.context(identifier)["unaccepted_changes"] is False
    old_confirmation = service.history(identifier, before=2)[0]["confirmation"]
    assert old_confirmation["decision"] == "用户采用初稿，暂不运行"
    with pytest.raises(ProjectConflict):
        service.save(identifier, draft("另一位作者"), expected_revision=1, reason="冲突")


def test_old_database_migration_and_failed_transaction_rollback(tmp_path: Path) -> None:
    service, identifier = setup(tmp_path)
    with sqlite3.connect(service.store.path) as db:
        for table in ("research_heads", "research_confirmations", "research_revisions"):
            db.execute(f"DROP TABLE {table}")
        db.execute("PRAGMA user_version=1")
    assert service.context(identifier)["research_revision"] == 0
    with sqlite3.connect(service.store.path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 1
    service.save(identifier, draft(), expected_revision=0, reason="迁移")
    with sqlite3.connect(service.store.path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 6
        db.execute(
            "CREATE TRIGGER reject_head BEFORE UPDATE ON research_heads "
            "BEGIN SELECT RAISE(ABORT, 'injected'); END"
        )
    with pytest.raises(sqlite3.IntegrityError, match="injected"):
        service.save(identifier, draft("new"), expected_revision=1, reason="rollback")
    assert service.context(identifier)["research_revision"] == 1
    assert len(service.history(identifier)) == 1
    assert service.projects.get(identifier).original_goal == "原始研究目标，不可改写"


def test_user_edits_survive_then_explicit_import_and_future_save(tmp_path: Path) -> None:
    service, identifier = setup(tmp_path)
    background = tmp_path / "research/docs/background.md"
    text = "# 我的笔记\n\n先分析数据，不要直接训练。\n"
    background.write_text(text)
    result = service.save(identifier, draft(), expected_revision=0, reason="初稿")
    assert result["saved"] and result["projection"]["status"] == "pending"
    assert background.read_text() == text
    # Further drafts may be saved even when the user intentionally keeps a projection edited.
    result = service.save(identifier, draft("先检查数据"), expected_revision=1, reason="新要求")
    assert result["projection"]["status"] == "pending"
    imported = service.import_notes(
        identifier, background, section="background", expected_revision=2, reason="导入用户笔记"
    )
    assert imported["projection"]["status"] == "ready"
    assert imported["research"]["document"]["brief"]["background"] == text
    assert text in background.read_text()
    updated = imported["research"]["document"]
    updated["next_step"] = "检查数据格式"
    assert (
        service.save(
            identifier, ResearchDraft.from_dict(updated), expected_revision=3, reason="下一步"
        )["projection"]["status"]
        == "ready"
    )
    assert service.show(identifier, 1)["research"]["document"]["brief"]["background"] == ""


def test_deleted_projection_and_symlink_are_preserved(tmp_path: Path) -> None:
    service, identifier = setup(tmp_path)
    goal = tmp_path / "research/docs/research-goal.md"
    goal.unlink()
    external = tmp_path / "external"
    external.write_text("keep")
    (tmp_path / "research/docs/background.md").unlink()
    (tmp_path / "research/docs/background.md").symlink_to(external)
    result = service.save(identifier, draft(), expected_revision=0, reason="draft")
    assert result["projection"]["status"] == "pending"
    assert not goal.exists() and external.read_text() == "keep"
    assert service.export(identifier)["status"] == "pending"


_CHILD = """
import os, sys
from pathlib import Path
from agent_infra.projects import ResearchDraft
from agent_infra.projects.local import LocalProjectStore
from agent_infra.projects.research import ResearchService
from agent_infra.projects import _filesystem as fs
root, phase = Path(sys.argv[1]), sys.argv[2]
service = ResearchService(LocalProjectStore(root / 'state/projects'))
identifier = service.store.list_projects()[0].project_id
if phase == 'committed':
    def crash(*args): os._exit(71)
    service._export = crash
elif phase == 'one_file':
    original = fs.write_file
    def crash(*args, **kwargs):
        original(*args, **kwargs)
        os._exit(71)
    fs.write_file = crash
elif phase == 'all_files':
    def crash(*args): os._exit(71)
    service.store.finish_research_export = crash
doc = {'schema_version': 1, 'brief': {'question': phase if phase.startswith('writer') else 'test'}}
service.save(identifier, ResearchDraft.from_dict(doc), expected_revision=0, reason='test')
"""


@pytest.mark.parametrize("phase", ["committed", "one_file", "all_files"])
def test_process_death_after_save_can_recover_without_another_revision(
    tmp_path: Path, phase: str
) -> None:
    service, identifier = setup(tmp_path)
    result = subprocess.run(
        [sys.executable, "-c", _CHILD, str(tmp_path), phase],
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 71, result.stderr
    ctx = service.context(identifier)
    assert ctx["research_revision"] == 1 and ctx["projection_pending"]
    again = service.save(
        identifier, ResearchDraft.from_dict(ctx["document"]), expected_revision=0, reason="test"
    )
    assert again["research"]["revision"] == 1
    assert again["projection"]["status"] == "ready"
    assert not service.context(identifier)["projection_pending"]


def test_two_processes_cannot_overwrite_each_others_draft(tmp_path: Path) -> None:
    service, identifier = setup(tmp_path)

    def run(number: int) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-c", _CHILD, str(tmp_path), f"writer{number}"],
            capture_output=True,
            text=True,
            timeout=20,
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(run, range(2)))
    assert sorted(r.returncode for r in results) == [0, 1], [r.stderr for r in results]
    assert "research revision changed" in next(r.stderr for r in results if r.returncode)
    assert len(service.history(identifier)) == 1


def test_check_uses_existing_resource_schema_without_allocating(tmp_path: Path) -> None:
    service, identifier = setup(tmp_path)
    workspace = tmp_path / "research"
    resource = workspace / "configs/resources/pilot.yaml"
    resource.write_text("version: 1\nrequest_id: pilot\nresources:\n  cpu: 2\n  memory: 4GiB\n")
    data = workspace / "data/manifests/source.md"
    data.write_text("Data description")
    doc = draft().to_dict()
    doc["brief"]["unknowns"] = []
    exp = doc["plan"]["experiments"][0]
    exp.update(
        resource_request="configs/resources/pilot.yaml",
        inputs=[{"path": "data/manifests/source.md", "version": "v1"}],
        metrics=[{"name": "report", "direction": "inspect"}],
    )
    service.save(identifier, ResearchDraft.from_dict(doc), expected_revision=0, reason="inputs")
    check = service.check(identifier)
    assert check["issues"] == [] and check["execution_validated"] is False
    resource.write_text("version: 1\nresources: {}\n")
    assert any("resource_request" in i["field"] for i in service.check(identifier)["issues"])
    data.unlink()
    data.symlink_to(tmp_path / "external")
    assert any("symlink" in i["message"] for i in service.check(identifier)["issues"])


def test_skill_install_is_local_repeatable_and_preserves_edits(tmp_path: Path) -> None:
    service, identifier = setup(tmp_path)
    content = service.skill(identifier)["files"]
    assert not (tmp_path / "research/.agents").exists()
    path = Path(service.skill(identifier, install=True)["skill_path"])
    for name, text in content.items():
        assert (path / name).read_text() == text
    assert service.skill(identifier, install=True)["skill_path"] == str(path)
    (path / "SKILL.md").write_text("User edits")
    with pytest.raises(ProjectConflict):
        service.skill(identifier, install=True)
    assert (path / "SKILL.md").read_text() == "User edits"


def test_import_race_does_not_clobber_later_notes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service, identifier = setup(tmp_path)
    service.save(identifier, draft(), expected_revision=0, reason="draft")
    notes = tmp_path / "research/docs/background.md"
    notes.write_text("first notes")
    original = service.store.save_research

    def racing(*args: Any, **kwargs: Any) -> Any:
        saved = original(*args, **kwargs)
        notes.write_text("later notes")
        return saved

    monkeypatch.setattr(service.store, "save_research", racing)
    result = service.import_notes(
        identifier, notes, section="background", expected_revision=1, reason="import"
    )
    assert result["projection"]["status"] == "pending"
    assert notes.read_text() == "later notes"
    assert result["research"]["document"]["brief"]["background"] == "first notes"


def test_cli_save_context_confirmation_and_malformed_json(tmp_path: Path) -> None:
    _, identifier = setup(tmp_path)

    def cli(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["agent-infra", "project", "research", *args, "--state-dir", str(tmp_path / "state")],
            cwd="/tmp",
            capture_output=True,
            text=True,
            timeout=20,
        )

    payload = tmp_path / "draft.json"
    payload.write_text(draft().content_json)
    result = cli(
        "save",
        identifier,
        "--file",
        str(payload),
        "--expected-revision",
        "0",
        "--reason",
        "initial",
    )
    assert result.returncode == 0, result.stderr
    revision = json.loads(result.stdout)["research"]
    assert (
        cli(
            "confirm",
            identifier,
            "--revision",
            "1",
            "--digest",
            revision["digest"],
            "--decision",
            "adopted for planning",
        ).returncode
        == 0
    )
    ctx = cli("context", identifier)
    assert json.loads(ctx.stdout)["accepted_revision"] == 1
    payload.write_text("{broken")
    bad = cli(
        "save", identifier, "--file", str(payload), "--expected-revision", "1", "--reason", "bad"
    )
    assert bad.returncode == 2 and "Traceback" not in bad.stderr
    assert json.loads(bad.stderr)["error"] == "invalid_project"


def test_duplicate_json_keys_cannot_silently_change_a_proposal() -> None:
    with pytest.raises(ProjectError, match="duplicate"):
        ResearchDraft('{"schema_version": 1, "brief": {"question": "a", "question": "b"}}')
