"""Composition and lifecycle for the simple local console."""

import secrets
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from time import monotonic
from typing import Any

from agent_infra.agents import AgentRegistry
from agent_infra.bootstrap.benchmark_console import BenchmarkConsole
from agent_infra.bootstrap.paths import prepare_controller_root, state_root
from agent_infra.bootstrap.research import project_runs
from agent_infra.gateways.cli.runs import ControllerClient
from agent_infra.gateways.http.server import create_server
from agent_infra.gateways.http.workflow import WorkflowGateway
from agent_infra.projects.catalog import ProjectCatalogBridge
from agent_infra.projects.console import ProjectConsole
from agent_infra.projects.local import LocalProjectStore
from agent_infra.records.local import LocalRecordsStore
from agent_infra.records.metrics import MetricIndex
from agent_infra.resources.monitor import LinuxHostResourceMonitor
from agent_infra.resources.sampling import ResourceSampler
from agent_infra.runs.console import ConsoleService
from agent_infra.runs.control_store import RunControlStore
from agent_infra.runs.query import RunQueries
from agent_infra.runs.research_store import ResearchStore
from agent_infra.runs.review import ExperimentReviews


class AgentDiagnostics:
    def __init__(self, registry: AgentRegistry) -> None:
        self.registry = registry
        self._lock = Lock()
        self._updated = 0.0
        self._cached: list[dict[str, Any]] = []

    def read(self) -> list[dict[str, Any]]:
        with self._lock:
            if self._cached and monotonic() - self._updated < 60:
                return self._cached
            items = []
            for provider in self.registry.providers:
                agent = self.registry.get(provider)
                item: dict[str, Any] = {
                    "provider": provider,
                    "name": agent.descriptor.display_name,
                    "capabilities": sorted(agent.descriptor.capabilities),
                    "checked_at": datetime.now(UTC).isoformat(),
                }
                try:
                    probe = asdict(agent.probe())
                    item.update(
                        {
                            key: probe[key]
                            for key in (
                                "available",
                                "version",
                                "authenticated",
                                "compatible",
                                "container_auth_reusable",
                                "issues",
                            )
                        }
                    )
                except Exception:
                    item.update(available=None, authenticated=None, issues=["探测失败"])
                items.append(item)
            self._cached, self._updated = items, monotonic()
            return items


def serve_console(
    registry: AgentRegistry,
    records_root: Path | None,
    console_dir: Path,
    web_root: Path,
    task_paths: tuple[Path, ...],
    port: int,
    state_dir: str | None = None,
) -> int:
    if not (web_root / "index.html").is_file():
        raise ValueError("Web 构建不存在，请先执行 pnpm build 并设置 --web-root")
    state = state_root(state_dir)
    control_root = prepare_controller_root(state)
    projects = LocalProjectStore(state / "projects")
    catalog = ProjectCatalogBridge(projects, console_dir / "projects.sqlite3")
    controller_records = LocalRecordsStore(control_root / "records")
    sampler = ResourceSampler(LinuxHostResourceMonitor().sample)
    service = ConsoleService(
        LocalRecordsStore(records_root) if records_root else controller_records,
        catalog,
        sampler.read,
        AgentDiagnostics(registry).read,
        task_paths,
    )
    workflow_console = ConsoleService(
        controller_records, catalog, sampler.read, service.agents, task_paths
    )
    catalog.remember_tasks(service.tasks())
    queries = RunQueries(RunControlStore(control_root), controller_records)
    workflow = WorkflowGateway(
        ProjectConsole(
            projects,
            catalog,
            run_references=lambda p: project_runs(state, p),
        ),
        workflow_console,
        queries,
        ResearchStore(control_root),
        lambda path, body: ControllerClient(state).request(
            path, body, timeout=3 if path == "health" else 120
        ),
        reviews=ExperimentReviews(queries, MetricIndex(controller_records).read),
    )
    token = secrets.token_urlsafe(32)
    server = create_server(
        service, web_root, token, port, workflow=workflow, benchmark=BenchmarkConsole(state)
    )
    sampler.start()
    print(f"Local console: http://127.0.0.1:{server.server_port}/#token={token}", flush=True)
    print("仅本机管理员访问；令牌随服务重启失效。Ctrl+C 退出。", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        sampler.close()
    return 0
