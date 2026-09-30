"""Real HTTP/Records review fixture with explicitly simulated command execution."""

import json
import shutil
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from uuid import uuid4

from agent_infra.contracts.files import content_digest
from agent_infra.environments.api import Submission
from agent_infra.gateways.cli.runs import ControllerClient
from agent_infra.gateways.http.control import create_control_server
from agent_infra.projects.sessions import SessionBinding, SessionBindingStore
from agent_infra.records.api import (
    AttemptManifest,
    EventDraft,
    ProducerKind,
    RecordContext,
    RunManifest,
)
from agent_infra.records.metrics import MetricIndex
from agent_infra.resources.api import LeaseCapacity
from agent_infra.resources.persistent import PersistentLeaseStore
from agent_infra.runs.command_api import CommandRequest
from agent_infra.runs.commands import CommandRuns
from agent_infra.runs.review import ExperimentReviews
from tests.unit.runs.test_commands import CommandBackend
from tests.web.workflow_fixture import TOKEN, fixture


class ReviewBackend(CommandBackend):
    def __init__(self, root):
        super().__init__(root)
        self.done = True
        self.workspaces = {}

    def submit(self, operation, spec):
        handle = super().submit(operation, spec)
        workspace = Path(spec.workspace)
        evidence = workspace / ".infra-evidence"
        shutil.copytree(Path(spec.snapshot).parent / "evidence", evidence)
        output = workspace / "outputs"
        output.mkdir()
        output.joinpath("metrics.jsonl").write_text(
            "".join(
                json.dumps(
                    {"step": step, "loss": 1 / (step + self.launches), "accuracy": step / 10}
                )
                + "\n"
                for step in range(1, 6)
            )
        )
        self.workspaces[operation] = workspace
        return handle

    def observe(self, handle, cursor=0):
        return replace(super().observe(handle, cursor), status="completed", exit_code=0)

    def collect(self, handle):
        path = self.workspaces[handle.operation_id]
        collection = path.parent / (path.name + "-collected")
        if not collection.exists():
            shutil.copytree(path, collection / "outputs")
        return Submission(collection, content_digest(collection), ("outputs",), ())


@contextmanager
def review_fixture(root):
    with fixture(root) as app:
        control = app["control"]
        metrics = MetricIndex(control.records)
        commands = CommandRuns(
            control.store,
            control.records,
            ReviewBackend(root / "review-results"),
            root / "commands",
            PersistentLeaseStore(root / "leases", LeaseCapacity(1, 1, 256 * 1024**2, 0)),
            lambda _: "sha256:fixture-image",
            lambda _: None,
            after_archive=metrics.index,
        )
        source = app["workspace"] / "train.py"
        source.write_text('print("explicit review fixture v1")')
        request = CommandRequest(
            project=str(app["workspace"]),
            project_id=app["project"],
            name="学习率对比 · Fixture",
            image="python:fixture",
            argv=("python", "train.py"),
            memory_bytes=128 * 1024**2,
        )
        first = commands.submit("fixture-first", request)
        source.write_text('print("explicit review fixture v2")')
        second = commands.rerun(first["run_id"], "fixture-second")
        workflow = app["workflow"]
        workflow.reviews = ExperimentReviews(workflow.queries, metrics.read)
        binding = SessionBinding(
            "claude-code",
            str(uuid4()),
            app["project"],
            datetime.now(UTC).isoformat(),
            str(app["workspace"]),
        )
        SessionBindingStore(workflow.projects.store).bind(binding)
        records = control.records
        now = datetime.now(UTC)
        records.begin_run(RunManifest(binding.records_run_id, now, {"kind": "fixture"}))
        records.begin_attempt(
            AttemptManifest(
                binding.records_attempt_id,
                binding.records_run_id,
                now,
                coverage={"host_agent": "partial"},
            )
        )
        records.scoped_sink(
            RecordContext(
                binding.records_run_id,
                binding.records_attempt_id,
                "fixture-session",
                ProducerKind.AGENT,
            )
        ).append_events(
            (EventDraft("agent.message", {"text": "录制样例：查看两次实验的学习曲线"}),)
        )
        daemon = create_control_server(control, workflow.queries, TOKEN, 0, commands=commands)
        endpoint = root / "review-client/controller/endpoint.json"
        endpoint.parent.mkdir(parents=True)
        endpoint.write_text(json.dumps({"port": daemon.server_port, "token": TOKEN}))
        workflow.controller = ControllerClient(root / "review-client").request
        thread = Thread(target=daemon.serve_forever, daemon=True)
        thread.start()
        try:
            yield app | {
                "first": first["run_id"],
                "second": second["run_id"],
                "session": binding.records_run_id,
                "commands": commands,
            }
        finally:
            daemon.shutdown()
            daemon.server_close()
            thread.join(5)


if __name__ == "__main__":
    import signal

    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
    with (
        TemporaryDirectory(prefix="infra-review-web-") as temporary,
        review_fixture(Path(temporary)) as app,
    ):
        print(
            json.dumps(
                {key: app[key] for key in ("port", "project", "first", "second", "session")}
            ),
            flush=True,
        )
        signal.pause()
