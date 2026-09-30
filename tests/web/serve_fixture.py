"""Browser-only fixture server. No model calls or Docker jobs; data stays in a temp directory."""

import json
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory

from agent_infra.gateways.http.server import create_server
from agent_infra.projects.catalog import ProjectCatalogBridge
from agent_infra.projects.local import LocalProjectStore
from agent_infra.records import (
    AttemptManifest,
    EventDraft,
    ProducerKind,
    RecordContext,
    RunManifest,
)
from agent_infra.records.api import DataClass
from agent_infra.records.local import LocalRecordsStore
from agent_infra.resources import LinuxHostResourceMonitor
from agent_infra.resources.sampling import ResourceSampler
from agent_infra.runs.console import ConsoleService

TOKEN = "browser-fixture-only-not-a-production-secret"


def main():
    with TemporaryDirectory(prefix="agent-infra-web-test-") as temporary:
        root = Path(temporary)
        store = LocalRecordsStore(root / "records")
        now = datetime.now(UTC)
        store.begin_run(RunManifest("fixture-run", now, {"kind": "browser-fixture"}))
        store.begin_attempt(
            AttemptManifest("fixture-attempt", "fixture-run", now, "task", "fixture")
        )
        sink = store.scoped_sink(
            RecordContext("fixture-run", "fixture-attempt", "fixture", ProducerKind.AGENT)
        )
        sink.append_events(
            (
                EventDraft(
                    "agent.message", {"native": {"text": "Browser fixture: training finished"}}
                ),
                EventDraft(
                    "agent.message",
                    {"native": {"text": "EVALUATOR_SECRET_SENTINEL"}},
                    data_class=DataClass.PRIVATE_EVALUATION,
                ),
            )
        )
        platform = store.scoped_sink(
            RecordContext("fixture-run", "fixture-attempt", "environment", ProducerKind.ENVIRONMENT)
        )
        platform.append_events(
            (
                EventDraft(
                    "tool.requested",
                    {
                        "tool_call_id": "fixture-call",
                        "tool_name": "start",
                        "arguments": "HIDDEN_COMMAND",
                    },
                ),
                EventDraft(
                    "tool.completed",
                    {
                        "tool_call_id": "fixture-call",
                        "tool_name": "start",
                        "result": "HIDDEN_RESULT",
                    },
                ),
            )
        )
        output = root / "result.txt"
        output.write_text("fixture result")
        sink.commit_artifact(output, name="fixture-result.txt")
        sampler = ResourceSampler(LinuxHostResourceMonitor().sample)
        sampler.start()
        service = ConsoleService(
            store,
            ProjectCatalogBridge(LocalProjectStore(root / "projects"), root / "projects.sqlite3"),
            sampler.read,
            lambda: [],
            (Path("examples/task-packages/file-result/task.yaml"),),
        )
        server = create_server(service, Path("src/web/dist"), TOKEN, 0)
        print(json.dumps({"port": server.server_port}), flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()
            sampler.close()


if __name__ == "__main__":
    main()
