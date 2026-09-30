"""Local daemon composition. Projects, providers and Docker meet only here."""

import argparse
import json
import os
import secrets
import signal
import threading
from dataclasses import replace
from pathlib import Path
from typing import Any

from agent_infra.bootstrap.gpu import gpu_doctor
from agent_infra.bootstrap.host_research import import_host_trace, project_context
from agent_infra.bootstrap.iteration import StudyActions
from agent_infra.bootstrap.node_resources import node_leases
from agent_infra.bootstrap.paths import prepare_controller_root, state_root
from agent_infra.bootstrap.run_preflight import prepare_compiled_run
from agent_infra.environments import planner_client as planner_helper
from agent_infra.environments.command import DockerCommandBackend
from agent_infra.environments.docker import DockerEnvironment
from agent_infra.environments.model_proxy import ModelProxyRelay, model_connection
from agent_infra.environments.preparation_docker import DockerEnvironmentPreparer
from agent_infra.environments.preparation_store import EnvironmentCatalog
from agent_infra.environments.recovery import inspect_local_image, recover_owned_containers
from agent_infra.environments.research import DockerResearchEnvironment
from agent_infra.gateways.cli.environment import environment_client
from agent_infra.gateways.cli.research_runtime import research_client
from agent_infra.gateways.cli.runs import run_client
from agent_infra.gateways.cli.study import planner_client, study_client
from agent_infra.gateways.http.control import create_control_server
from agent_infra.gateways.mcp.research import serve_mcp
from agent_infra.projects.local import LocalProjectStore
from agent_infra.projects.service import ProjectService
from agent_infra.records.local import LocalRecordsStore
from agent_infra.records.metrics import MetricIndex
from agent_infra.resources import LinuxHostResourceMonitor, LocalResourceManager, NodeCapacity
from agent_infra.resources.api import LeaseCapacity
from agent_infra.resources.gpu import authorized_gpus
from agent_infra.runs.command_api import CommandRequest
from agent_infra.runs.commands import CommandRuns
from agent_infra.runs.control_api import PreparedRun, SubmissionRequest
from agent_infra.runs.control_store import RunControlStore
from agent_infra.runs.controller import LocalRunController
from agent_infra.runs.environment_preparation import EnvironmentPreparation
from agent_infra.runs.host_lock import HostControllerLock
from agent_infra.runs.planner import PlannerSessions
from agent_infra.runs.query import RunQueries
from agent_infra.runs.research import ResearchController
from agent_infra.runs.research_store import ResearchStore
from agent_infra.runs.service import LocalRunService


def run_action(args: argparse.Namespace) -> dict[str, Any] | int:
    state = state_root(args.state_dir)
    if args.command == "planner":
        return planner_client(state, args)
    if args.command == "study":
        return study_client(state, args)
    if args.command == "run":
        return run_client(state, args)
    if args.command == "environment":
        return environment_client(state, args)
    if args.command == "research":
        return research_client(state, args)
    if args.command == "mcp":
        serve_mcp(state, args.project_id, args.session_id)
        return 0
    return serve_controller(
        state,
        port=args.port,
        cpu=args.cpu,
        memory_bytes=int(args.memory_gib * 1024**3),
        proxy=args.model_proxy,
        gpu_uuids=tuple(args.gpu_uuid),
    )


def serve_controller(
    state: Path,
    *,
    port: int,
    cpu: float,
    memory_bytes: int,
    proxy: str = "auto",
    gpu_uuids: tuple[str, ...] = (),
) -> int:
    root = prepare_controller_root(state)
    lock = HostControllerLock(state)
    controller: LocalRunController | None = None
    research: ResearchController | None = None
    preparation: EnvironmentPreparation | None = None
    planner: PlannerSessions | None = None
    commands: CommandRuns | None = None
    clean = False
    relay: ModelProxyRelay | None = None
    endpoint = root / "endpoint.json"
    previous_handler = signal.getsignal(signal.SIGTERM)
    try:
        monitor = LinuxHostResourceMonitor()
        snapshot = monitor.sample()
        allowed_gpus = authorized_gpus(snapshot, gpu_uuids)
        if allowed_gpus:
            diagnosis = gpu_doctor(snapshot)
            if not diagnosis["ready"]:
                issues = diagnosis["issues"]
                detail = (
                    "; ".join(str(issue) for issue in issues)
                    if isinstance(issues, list)
                    else str(issues)
                )
                raise ValueError("GPU runtime unavailable: " + detail)
        cdi_devices = diagnosis["cdi_devices"] if allowed_gpus else []
        gpu_mode = (
            "cdi"
            if isinstance(cdi_devices, list)
            and all(f"nvidia.com/gpu={gpu.device_id}" in cdi_devices for gpu in allowed_gpus)
            else "legacy"
        )
        leases = node_leases(root, LeaseCapacity(256, cpu, memory_bytes, len(allowed_gpus)))
        resources = LocalResourceManager(
            NodeCapacity(snapshot.node_id, cpu, memory_bytes, gpus=allowed_gpus),
            persistent=leases,
            owner_namespace="controller:" + leases.scope,
        )
        resources.update_snapshot(snapshot)
        records = LocalRecordsStore(root / "records")
        environment = DockerEnvironment(root / "environments", gpu_mode=gpu_mode)
        service = LocalRunService(
            environment, resources, root / "work", node_id=snapshot.node_id, records=records
        )
        connection: tuple[tuple[str, str], ...] | None = None
        connection_lock = threading.Lock()

        def get_connection() -> tuple[tuple[str, str], ...]:
            nonlocal connection, relay
            with connection_lock:
                if connection is None:
                    connection, relay = model_connection(proxy)
                return connection

        def prepare(request: SubmissionRequest) -> PreparedRun:
            prepared = prepare_compiled_run(state, request)
            return replace(
                prepared, request=replace(prepared.request, connection_environment=get_connection())
            )

        controller = LocalRunController(
            RunControlStore(root),
            service,
            records,
            resources,
            prepare,
            lambda: resources.update_snapshot(monitor.sample()),
            lambda: recover_owned_containers(root / "environments"),
        )
        projects = ProjectService(LocalProjectStore(state / "projects"))

        def command_project(request: CommandRequest) -> str:
            if request.project_id is not None:
                project = projects.get(request.project_id)
                if Path(project.workspace) != Path(request.project).resolve():
                    raise ValueError("command project does not match its registered workspace")
            else:
                project = projects.attach(Path(request.project))
            return project.project_id

        def authorize_command(request: CommandRequest) -> None:
            if request.cpu_cores > cpu or request.memory_bytes > memory_bytes:
                raise ValueError("command exceeds the Controller CPU/memory authorization")
            if set(request.gpu_device_ids) - set(gpu_uuids):
                raise ValueError("GPU UUID is not authorized by this Controller")

        commands = CommandRuns(
            controller.store,
            records,
            DockerCommandBackend(root / "commands", gpu_mode=gpu_mode),
            root / "commands",
            leases,
            lambda image: inspect_local_image(image),
            authorize_command,
            project=command_project,
            after_archive=MetricIndex(records).index,
        )
        commands.start()
        preparation = EnvironmentPreparation(
            controller,
            EnvironmentCatalog(root / "preparation"),
            DockerEnvironmentPreparer(environment),
        )
        study = StudyActions(state, controller, RunQueries(controller.store, records))
        research = ResearchController(
            controller,
            ResearchStore(root),
            DockerResearchEnvironment(environment),
            records,
            lambda identifier: project_context(state, identifier),
            inspect_local_image,
            import_host_trace,
            preparation,
            study.call,
        )
        planner = PlannerSessions(
            controller,
            environment,
            study.planner_call,
            Path(planner_helper.__file__),
            lambda image: inspect_local_image(image, provider="codex"),
            get_connection,
        )
        token = secrets.token_urlsafe(32)
        server = create_control_server(
            controller,
            RunQueries(controller.store, records),
            token,
            port,
            research=research,
            planner=planner,
            commands=commands,
        )
        with server:
            temporary = root / "endpoint.tmp"
            with temporary.open("w") as file:
                os.chmod(temporary, 0o600)
                json.dump({"port": server.server_port, "token": token, "pid": os.getpid()}, file)
                file.flush()
                os.fsync(file.fileno())
            temporary.replace(endpoint)
            print(
                json.dumps(
                    {
                        "controller": "ready",
                        "port": server.server_port,
                        "state_dir": str(state),
                        "cpu": cpu,
                        "memory_bytes": memory_bytes,
                        "authorized_gpu_uuids": [gpu.device_id for gpu in allowed_gpus],
                        "gpu_mode": gpu_mode if allowed_gpus else "disabled",
                    }
                ),
                flush=True,
            )

            def stop(signum: int, frame: Any) -> None:
                raise KeyboardInterrupt

            signal.signal(signal.SIGTERM, stop)
            try:
                server.serve_forever(poll_interval=0.2)
            except KeyboardInterrupt:
                pass
        return 0
    finally:
        signal.signal(signal.SIGTERM, previous_handler)
        if commands is not None:
            commands.close()
        planner_clean = planner.close() if planner is not None else True
        preparation_clean = preparation.close() if preparation is not None else True
        research_clean = research.close() if research is not None else True
        if controller is not None:
            clean = controller.close() and research_clean and preparation_clean and planner_clean
            endpoint.unlink(missing_ok=True)
        if relay is not None:
            relay.close()
        lock.close(clean=clean)
