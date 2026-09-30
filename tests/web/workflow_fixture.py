"""Real HTTP/SQLite/Projects/Records; explicitly fake Agent and environment, no Docker/model."""

import json
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread

from agent_infra.gateways.cli.runs import ControllerClient
from agent_infra.gateways.http.control import create_control_server
from agent_infra.gateways.http.server import create_server
from agent_infra.gateways.http.workflow import WorkflowGateway
from agent_infra.projects.analysis import AnalysisService
from agent_infra.projects.catalog import ProjectCatalogBridge
from agent_infra.projects.console import ProjectConsole
from agent_infra.records import (
    AttemptManifest,
    DataClass,
    EventDraft,
    ProducerKind,
    RecordContext,
    RunManifest,
)
from agent_infra.runs.console import ConsoleService
from agent_infra.runs.query import RunQueries
from agent_infra.runs.research_store import ResearchStore
from tests.fixtures.legacy_catalog import seed_catalog
from tests.unit.projects.test_compilation import compile, setup
from tests.unit.runs.test_controller import setup_controller
from tests.unit.runs.test_service import FakeEnvironment

TOKEN = "web-workflow-fixture-not-a-production-secret"


@contextmanager
def fixture(root: Path):
    compiler, project, workspace = setup(root)
    compiled = compile(compiler, project)
    control, env, prepared = setup_controller(
        root / "runtime", environment=FakeEnvironment(outcome="running")
    )
    control.prepare = lambda _: replace(
        prepared, lineage={"project_id": project, "experiment_id": "pilot"}
    )
    queries = RunQueries(control.store, control.records)
    catalog = ProjectCatalogBridge(compiler.store, root / "console/projects.sqlite3")
    console = ConsoleService(
        control.records,
        catalog,
        lambda: {},
        lambda: [],
        (Path("examples/task-packages/file-result/task.yaml"),),
    )
    task = console.tasks()[0]
    legacy = {
        "id": "legacy-project",
        "revision": 1,
        "name": "旧科研项目",
        "goal": "保留旧目标",
        "status": "planned",
        "milestones": [{"title": "原有里程碑", "done": True}],
        "run_ids": [],
        "task_keys": [task["key"]],
        "updated_at": "2026-09-17T00:00:00+00:00",
    }
    seed_catalog(catalog.path, [legacy], ((task["key"], task["task_id"], task["revision"]),))
    # Seed immutable evidence independently from the fake active run, including private sentinels.
    finished = control.store.create("fixture-result", {"kind": "research"}, {"project_id": project})
    records, now = control.records, datetime.now(UTC)
    records.begin_run(RunManifest(finished["run_id"], now, {}))
    records.begin_attempt(AttemptManifest(finished["attempt_id"], finished["run_id"], now))
    sink = records.scoped_sink(
        RecordContext(finished["run_id"], finished["attempt_id"], "fixture", ProducerKind.AGENT)
    )
    sink.append_events(
        (
            EventDraft("agent.message", {"text": "Explicit fixture: computed mean 2.0"}),
            EventDraft(
                "agent.message",
                {"text": "PRIVATE_W_SENTINEL"},
                data_class=DataClass.PRIVATE_EVALUATION,
            ),
        )
    )
    metrics = root / "metrics.json"
    metrics.write_text('{"mean": 2.0}')
    artifact = sink.commit_artifact(metrics, name="metrics.json")
    private = sink.commit_artifact(
        metrics, name="PRIVATE_W_SENTINEL", data_class=DataClass.PRIVATE_EVALUATION
    )
    records.finish_attempt(
        finished["attempt_id"], status="completed", result={"cleanup_complete": True}
    )
    records.finish_run(finished["run_id"], status="completed")
    control.store.update(
        finished["run_id"],
        state="finished",
        result={
            "status": "completed",
            "cleanup_complete": True,
            "private_log": "PRIVATE_W_SENTINEL",
        },
    )
    analysis = AnalysisService(compiler.store, queries)
    analysis.save(
        project,
        "fixture-analysis",
        {
            "results": [
                {
                    "run_id": finished["run_id"],
                    "artifact_id": artifact.artifact_id,
                    "member": "metrics.json",
                    "metrics": [
                        {
                            "name": "mean",
                            "pointer": "/mean",
                            "unit": "value",
                            "direction": "inspect",
                        }
                    ],
                }
            ],
            "observations": "Fixture 均值为 2",
            "interpretation": "Fixture 解释",
            "uncertainty": "不是科学验收",
            "recommendation": "检查更大样本",
        },
    )
    jobs = ResearchStore(root / "runtime/controller")
    jobs.save_job(
        {
            "job_id": "fixture-job",
            "run_id": finished["run_id"],
            "state": "exited",
            "exit_code": 0,
            "request": {"secret": "PRIVATE_W_SENTINEL"},
        }
    )
    daemon = create_control_server(control, queries, TOKEN, 0)
    endpoint = root / "client/controller/endpoint.json"
    endpoint.parent.mkdir(parents=True)
    endpoint.write_text(json.dumps({"port": daemon.server_port, "token": TOKEN}))
    client = ControllerClient(root / "client")
    projects = ProjectConsole(compiler.store, catalog)
    workflow = WorkflowGateway(projects, console, queries, jobs, client.request)
    server = create_server(console, Path("src/web/dist"), TOKEN, 0, workflow=workflow)
    threads = [Thread(target=s.serve_forever, daemon=True) for s in (daemon, server)]
    for t in threads:
        t.start()
    try:
        yield {
            "port": server.server_port,
            "project": project,
            "legacy": legacy["id"],
            "workspace": workspace,
            "compiled": compiled["compiled"],
            "workflow": workflow,
            "finished": finished["run_id"],
            "artifact": artifact.artifact_id,
            "private": private.artifact_id,
            "root": root,
            "control": control,
            "env": env,
            "daemon": daemon,
        }
    finally:
        control.close()
        for s in (server, daemon):
            s.shutdown()
            s.server_close()
        for t in threads:
            t.join(timeout=5)


if __name__ == "__main__":
    import signal

    def stop(signum, frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)

    with TemporaryDirectory(prefix="agent-infra-w-browser-") as temporary:
        with fixture(Path(temporary)) as value:
            print(
                json.dumps(
                    {k: value[k] for k in ("port", "project", "legacy", "finished")}
                    | {"root": str(value["root"])}
                ),
                flush=True,
            )
            signal.pause()
