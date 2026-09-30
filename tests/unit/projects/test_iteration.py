"""Real Project/Records transactions; explicit fixture execution for budget fault tests."""

import copy
import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, replace
from datetime import UTC, datetime

import pytest

from agent_infra.projects.analysis import AnalysisService
from agent_infra.projects.api import ProjectConflict, ProjectError
from agent_infra.projects.iteration import IterationService
from agent_infra.projects.iteration_api import digest
from agent_infra.records import AttemptManifest, DataClass, ProducerKind, RecordContext, RunManifest
from agent_infra.runs.query import RunQueries
from tests.unit.projects.test_research import draft, setup
from tests.unit.runs.test_controller import REQUEST, setup_controller, wait_finished


def services(root):
    research, project = setup(root)
    saved = research.save(project, draft(), expected_revision=0, reason="fixture")["research"]
    research.confirm(project, revision=1, digest=saved["digest"], decision="fixture user")
    control, _, prepared = setup_controller(root / "execution")
    prepared = replace(prepared, lineage={"project_id": project, "research_revision": 1})
    control.prepare = lambda _: prepared
    query = RunQueries(control.store, control.records)
    return (
        research,
        project,
        control,
        AnalysisService(research.store, query),
        IterationService(research.store, control, query),
    )


def policy(research, project, **extra):
    return {
        "authorization": "user approved two fixture experiments",
        "tasks": [asdict(REQUEST)],
        "max_experiments": 2,
        "total_seconds": 1200,
        "wall_seconds": 3600,
        "cpu": 1,
        "memory_bytes": 2 * 1024**3,
        "expected_revision": 1,
        "expected_digest": research.context(project)["digest"],
        **extra,
    }


def evidence(control, project, root, *, private=False, failed=False):
    run = control.store.create("evidence", {}, {"project_id": project})
    now = datetime.now(UTC)
    control.records.begin_run(RunManifest(run["run_id"], now, {}))
    control.records.begin_attempt(AttemptManifest(run["attempt_id"], run["run_id"], now))
    path = root / "metrics.json"
    path.write_text(json.dumps({"loss": 0.25}))
    sink = control.records.scoped_sink(
        RecordContext(run["run_id"], run["attempt_id"], "fixture", ProducerKind.RUN)
    )
    artifact = sink.commit_artifact(
        path,
        name="metrics",
        data_class=DataClass.PRIVATE_EVALUATION if private else DataClass.PUBLIC,
    )
    outcome = {"status": "failed" if failed else "completed", "cleanup_complete": True}
    control.records.finish_attempt(run["attempt_id"], status=outcome["status"], result=outcome)
    control.records.finish_run(run["run_id"], status=outcome["status"])
    control.store.update(run["run_id"], state="finished", result=outcome)
    return {
        "results": [
            {
                "run_id": run["run_id"],
                "artifact_id": artifact.artifact_id,
                "member": "metrics.json",
                "data_version": "v1",
                "code_version": "code1",
                "metrics": [
                    {
                        "name": "loss",
                        "unit": "dimensionless",
                        "direction": "minimize",
                        "pointer": "/loss",
                    }
                ],
            }
        ],
        "observations": "loss observed",
        "interpretation": "small fixture only",
        "uncertainty": "no repeated trials",
        "recommendation": "repeat",
    }


def test_analysis_extracts_real_bytes_immutable_and_private_rejected(tmp_path):
    research, project, control, analysis, _ = services(tmp_path)
    try:
        value = evidence(control, project, tmp_path)
        saved = analysis.save(project, "result", value)
        assert saved["evidence"][0]["metrics"][0]["value"] == 0.25
        assert analysis.save(project, "result", value) == saved
        changed = value | {"interpretation": "user correction", "supersedes": saved["analysis_id"]}
        newer = analysis.save(project, "correct", changed)
        assert saved["analysis_id"] != newer["analysis_id"]
        assert analysis.documents.get(project, "analysis", saved["analysis_id"]) == saved
        with pytest.raises(ProjectConflict):
            analysis.save(project, "result", changed)
        invalid = copy.deepcopy(value)
        invalid["results"][0]["artifact_id"] = "missing"
        with pytest.raises(KeyError):
            analysis.save(project, "missing", invalid)
        invalid["results"][0]["run_id"] = "missing"
        with pytest.raises(KeyError):
            analysis.save(project, "bad-run", invalid)
        groups = copy.deepcopy(saved["evidence"]) * 2
        groups[1] = copy.deepcopy(groups[1])
        groups[1]["data_version"] = "v2"
        comparison = analysis.compare(groups)
        assert not comparison["ranked"] and len(comparison["groups"]) == 2
        with pytest.raises(ProjectError, match="different project"):
            analysis.evidence("other-project", value["results"][0])
    finally:
        control.close()


def test_private_artifacts_and_failed_runs(tmp_path):
    _, project, control, analysis, _ = services(tmp_path)
    try:
        value = evidence(control, project, tmp_path, private=True, failed=True)
        with pytest.raises(KeyError):
            analysis.save(project, "private", value)
        value["results"] = [{"run_id": value["results"][0]["run_id"]}]
        saved = analysis.save(project, "failure", value)
        assert saved["evidence"][0]["outcome"]["status"] == "failed"
        assert saved["comparison"]["groups"] == []
    finally:
        control.close()


def test_decisions_reject_stale_and_resume_after_plan_save(tmp_path, monkeypatch):
    research, project, control, analysis, _ = services(tmp_path)
    try:
        result = analysis.save(project, "result", evidence(control, project, tmp_path))
        context = research.context(project)
        base = {
            "analysis_id": result["analysis_id"],
            "choice": "reject",
            "reason": "not enough evidence",
            "authorization": "user message",
            "expected_revision": 1,
            "expected_digest": context["digest"],
        }
        assert analysis.decide(project, "reject", base)["state"] == "completed"
        assert research.context(project)["research_revision"] == 1
        next_plan = copy.deepcopy(context["document"])
        next_plan["plan"]["experiments"][0]["id"] = "second"
        accept = base | {"choice": "modify", "draft": next_plan}
        confirm = analysis.store.confirm_research
        monkeypatch.setattr(
            analysis.store,
            "confirm_research",
            lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("crash after save")),
        )
        with pytest.raises(RuntimeError):
            analysis.decide(project, "accept", accept)
        assert research.context(project)["research_revision"] == 2
        monkeypatch.setattr(analysis.store, "confirm_research", confirm)
        recovered = analysis.decide(project, "accept", accept)
        assert recovered["research"]["revision"] == 2
        assert research.context(project)["accepted_revision"] == 2
        with pytest.raises(ProjectConflict, match="stale"):
            analysis.decide(project, "stale", base)
        assert len(control.store.list_runs()) == 1  # decision never creates a Run
    finally:
        control.close()


def test_concurrent_budget_and_submit_reply_loss(tmp_path, monkeypatch):
    research, project, control, _, iteration = services(tmp_path)
    try:
        authorized = iteration.authorize(
            project, "auth", policy(research, project, max_experiments=1)
        )
        workflow, task = authorized["workflow_id"], next(iter(authorized["tasks"]))
        submit = control.submit

        def lost(*args, **kwargs):
            submit(*args, **kwargs)
            raise RuntimeError("lost reply after durable submit")

        monkeypatch.setattr(control, "submit", lost)
        with pytest.raises(RuntimeError):
            iteration.step(project, workflow, "one", task)
        monkeypatch.setattr(control, "submit", submit)
        with ThreadPoolExecutor(4) as pool:
            runs = list(
                pool.map(lambda _: iteration.step(project, workflow, "one", task), range(8))
            )
        assert len({r["run_id"] for r in runs}) == 1
        wait_finished(control, runs[0]["run_id"])
        restarted = IterationService(research.store, control, iteration.queries)
        assert restarted.status(project, workflow)["state"] == "stopped"
        with pytest.raises(ProjectConflict, match="stopped"):
            restarted.step(project, workflow, "two", task)
        assert len(control.store.list_runs()) == 1
        assert restarted.status(project, workflow)["reserved_seconds"] == REQUEST.timeout_seconds
    finally:
        control.close()


def test_limits_stop_and_wrong_scope(tmp_path):
    research, project, control, _, iteration = services(tmp_path)
    try:
        auth = iteration.authorize(project, "auth", policy(research, project, total_seconds=600))
        key, task = auth["workflow_id"], next(iter(auth["tasks"]))
        with pytest.raises(ProjectError, match="outside"):
            iteration.step(project, key, "unknown", "missing")
        with pytest.raises(KeyError):
            iteration.status("other", key)
        first = iteration.step(project, key, "one", task)
        wait_finished(control, first["run_id"])
        with pytest.raises(ProjectConflict, match="budget"):
            iteration.step(project, key, "two", task)
        iteration.stop(project, key, "user stopped")
        with pytest.raises(ProjectConflict, match="stopped"):
            iteration.step(project, key, "new", task)
        assert not iteration.status(project, key)["cost"]["hard_limit_supported"]
        with pytest.raises(ProjectConflict):
            iteration.authorize(project, "stale", policy(research, project, expected_revision=2))
        future = IterationService(
            research.store, control, iteration.queries, clock=lambda: auth["deadline"] + 1
        )
        assert future.status(project, key)["state"] == "stopped"
        assert digest(asdict(REQUEST)) == task
    finally:
        control.close()


def test_distinct_concurrent_actions_share_one_budget(tmp_path):
    research, project, control, _, iteration = services(tmp_path)
    try:
        authorized = iteration.authorize(
            project, "limit", policy(research, project, max_experiments=1)
        )
        workflow, task = authorized["workflow_id"], next(iter(authorized["tasks"]))

        def submit(index):
            try:
                return iteration.step(project, workflow, f"round-{index}", task)
            except ProjectConflict:
                return None

        with ThreadPoolExecutor(4) as pool:
            results = list(pool.map(submit, range(4)))
        assert len([r for r in results if r is not None]) == 1
        assert len(control.store.list_runs()) == 1
        wait_finished(control, next(r for r in results if r)["run_id"])
    finally:
        control.close()


def test_changed_image_at_final_admission_and_pending_restart(tmp_path, monkeypatch):
    research, project, control, _, iteration = services(tmp_path)
    try:
        auth = iteration.authorize(project, "auth", policy(research, project))
        workflow, key = auth["workflow_id"], next(iter(auth["tasks"]))
        original = control.prepare
        original_prepared = original(REQUEST)
        count = 0

        def race(request):
            nonlocal count
            count += 1
            return (
                original_prepared
                if count == 1
                else replace(
                    original_prepared,
                    request=replace(original_prepared.request, resolved_image="different-image"),
                )
            )

        monkeypatch.setattr(control, "prepare", race)
        with pytest.raises(ValueError, match="identity changed"):
            iteration.step(project, workflow, "pending", key)
        assert not control.store.list_runs()
        state = iteration.status(project, workflow)
        assert len(state["actions"]) == 1
        monkeypatch.setattr(control, "prepare", original)
        resumed = IterationService(research.store, control, iteration.queries)
        run = resumed.step(project, workflow, "pending", key)
        wait_finished(control, run["run_id"])
        assert len(control.store.list_runs()) == 1
        assert resumed.status(project, workflow)["reserved_seconds"] == REQUEST.timeout_seconds
    finally:
        control.close()


def test_v3_read_does_not_migrate_and_first_write_preserves_research(tmp_path):
    import sqlite3

    research, project, control, analysis, _ = services(tmp_path)
    try:
        before = research.context(project)
        with sqlite3.connect(research.store.path) as db:
            db.execute("DROP TABLE iteration_documents")
            db.execute("PRAGMA user_version=3")
        assert analysis.list(project, "analysis") == {"items": []}
        with sqlite3.connect(research.store.path) as db:
            assert db.execute("PRAGMA user_version").fetchone()[0] == 3
        analysis.save(project, "migrate", evidence(control, project, tmp_path))
        with sqlite3.connect(research.store.path) as db:
            assert db.execute("PRAGMA user_version").fetchone()[0] == 6
        assert research.context(project) == before
    finally:
        control.close()
