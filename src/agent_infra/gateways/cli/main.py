"""CLI parsing only; configuration behavior is injected by bootstrap."""

import argparse
import json
from collections.abc import Callable, Sequence
from importlib.metadata import version
from pathlib import Path

from agent_infra.gateways.cli.benchmarks import add_benchmark_arguments
from agent_infra.gateways.cli.environment import add_environment_arguments
from agent_infra.gateways.cli.projects import (
    add_codex_session_arguments,
    add_compilation_arguments,
    add_init_arguments,
    add_research_arguments,
    add_session_arguments,
)
from agent_infra.gateways.cli.research_runtime import add_research_runtime_arguments
from agent_infra.gateways.cli.runs import add_run_arguments
from agent_infra.gateways.cli.study import add_planner_arguments, add_study_arguments
from agent_infra.projects import ProjectError


def run(
    check_config: Callable[[Path | None], dict[str, str]],
    probe_agent: Callable[[str], dict[str, object]],
    setup_agent: Callable[[str], dict[str, object]],
    inspect_resources: Callable[[], dict[str, object]],
    validate_resource_request: Callable[[Path], dict[str, object]],
    argv: Sequence[str] | None = None,
    *,
    task_action: Callable[[str, dict[str, str]], dict[str, object]] | None = None,
    records_action: Callable[[str, dict[str, str]], dict[str, object]] | None = None,
    project_action: Callable[[str, dict[str, str]], dict[str, object]] | None = None,
    web_action: Callable[[Path | None, Path, Path, tuple[Path, ...], int, str | None], int]
    | None = None,
    run_action: Callable[[argparse.Namespace], dict[str, object] | int] | None = None,
    gpu_action: Callable[[str, argparse.Namespace], dict[str, object]] | None = None,
    benchmark_action: Callable[[argparse.Namespace], dict[str, object]] | None = None,
) -> int:
    parser = argparse.ArgumentParser(description="Agent Infra engineering utilities")
    parser.add_argument("--version", action="version", version=version("agent-infra"))
    commands = parser.add_subparsers(dest="command", required=True)
    add_benchmark_arguments(commands)
    add_planner_arguments(commands)
    add_study_arguments(commands)
    add_run_arguments(commands)
    add_environment_arguments(commands)
    add_research_runtime_arguments(commands)
    add_init_arguments(
        commands.add_parser("init", help="Initialize a research project without a model")
    )
    project = commands.add_parser(
        "project", help="Initialize, inspect and recover research projects"
    )
    project_commands = project.add_subparsers(dest="project_command", required=True)
    add_compilation_arguments(project_commands)
    add_research_arguments(project_commands.add_parser("research", help="Persist research plans"))
    add_codex_session_arguments(
        project_commands.add_parser("codex", help="Bind local Codex sessions")
    )
    add_session_arguments(
        project_commands.add_parser("session", help="Discover and capture host Agent sessions")
    )
    for name in ("init", "preview"):
        add_init_arguments(project_commands.add_parser(name))
    for name in ("show", "list", "recover", "attach"):
        entry = project_commands.add_parser(name)
        if name != "list":
            entry.add_argument("identifier", help="Project UUID or original workspace path")
        entry.add_argument("--state-dir", help="Control state root")
    web = commands.add_parser("web", help="Start the local research console")
    web.add_argument("--records-root", type=Path, help="Optional legacy Records directory")
    web.add_argument("--state-dir", help="Same state root as init and controller serve")
    web.add_argument("--console-dir", type=Path, default=Path("var/console"))
    web.add_argument("--web-root", type=Path, default=Path("src/web/dist"))
    web.add_argument("--task", type=Path, action="append", default=[])
    web.add_argument("--port", type=int, default=8765)
    config = commands.add_parser(
        "config-check", help="Validate configuration; creates no runtime state"
    )
    config.add_argument("--config", type=Path, help="Optional TOML file")
    agent = commands.add_parser("agent", help="Inspect configured Agent providers")
    agent_commands = agent.add_subparsers(dest="agent_command", required=True)
    doctor = agent_commands.add_parser("doctor", help="Check provider installation and login")
    doctor.add_argument("provider", help="Provider name, for example codex, claude-code, or dsh")
    setup = agent_commands.add_parser("setup", help="Install a missing provider, then check it")
    setup.add_argument("provider", help="Provider name, for example codex, claude-code, or dsh")
    resource = commands.add_parser("resource", help="Inspect and validate execution resources")
    resource_commands = resource.add_subparsers(dest="resource_command", required=True)
    resource_commands.add_parser("inspect", help="Read a host CPU, memory and GPU snapshot")
    validate = resource_commands.add_parser("validate", help="Validate a resource request YAML")
    validate.add_argument("request", type=Path)
    resource_commands.add_parser("gpu-doctor", help="Check NVIDIA and Docker GPU readiness")
    smoke = resource_commands.add_parser(
        "gpu-smoke", help="Run a bounded CUDA calculation in an existing local image"
    )
    smoke.add_argument("--gpu-uuid", required=True)
    smoke.add_argument("--image", required=True, help="Existing local Python image")
    task = commands.add_parser("task", help="Prepare and inspect task manifests")
    task_commands = task.add_subparsers(dest="task_command", required=True)
    for name in ("validate", "view", "freeze"):
        entry = task_commands.add_parser(name)
        entry.add_argument("manifest")
    prepare = task_commands.add_parser("prepare")
    prepare.add_argument("manifest")
    prepare.add_argument("destination")
    resource_check = task_commands.add_parser("resource-check")
    resource_check.add_argument("manifest")
    resource_check.add_argument("request")
    draft = task_commands.add_parser("draft")
    draft.add_argument("instruction")
    draft.add_argument("--task-id", required=True)
    draft.add_argument("--data")
    draft.add_argument("--output", required=True)
    native = task_commands.add_parser("import-researchclaw")
    native.add_argument("workspace")
    native.add_argument("--native-id", required=True)
    native.add_argument("--source-revision", required=True)
    native.add_argument("--output", required=True)
    records = commands.add_parser("records", help="Inspect durable Run records and trajectories")
    records_commands = records.add_subparsers(dest="records_command", required=True)
    for name in ("run", "attempt", "events", "artifacts", "trajectory"):
        entry = records_commands.add_parser(name)
        entry.add_argument("identifier")
        entry.add_argument("--root", required=True)
        if name == "events":
            entry.add_argument("--limit", type=int, default=200)
    export = records_commands.add_parser("export")
    export.add_argument("identifiers", nargs="+")
    export.add_argument("--root", required=True)
    export.add_argument("--destination", required=True)
    args = parser.parse_args(argv)
    if args.command == "benchmark":
        if benchmark_action is None:
            parser.exit(2, "Benchmark planning is not configured\n")
        try:
            benchmark_result = benchmark_action(args)
        except (OSError, ValueError, RuntimeError, KeyError) as error:
            parser.exit(
                2,
                json.dumps(
                    {"error": "benchmark_planning", "message": str(error)}, ensure_ascii=False
                )
                + "\n",
            )
        print(json.dumps(benchmark_result, ensure_ascii=False, indent=2, default=str))
        return 1 if benchmark_result.get("compatible") is False else 0
    if args.command in {"run", "controller", "research", "mcp", "environment", "study", "planner"}:
        if run_action is None:
            parser.exit(2, "Run controller is not configured\n")
        try:
            run_result = run_action(args)
        except (OSError, ValueError, RuntimeError) as error:
            parser.exit(
                2,
                json.dumps({"error": "run_control", "message": str(error)}, ensure_ascii=False)
                + "\n",
            )
        if isinstance(run_result, int):
            return run_result
        print(json.dumps(run_result, default=str, ensure_ascii=False, indent=2))
        if args.command == "run" and (
            args.action == "wait" or (args.action == "command" and args.wait)
        ):
            raw_outcome = run_result.get("result")
            outcome = raw_outcome if isinstance(raw_outcome, dict) else {}
            status = outcome.get(
                "execution", outcome.get("execution_status", outcome.get("status"))
            )
            if status == "completed":
                return 0
            if status == "cancelled":
                return 130
            if status == "timed_out":
                return 124
            code = outcome.get("exit_code")
            return code if type(code) is int and 1 <= code <= 125 else 1
        return 1 if run_result.get("ready") is False else 0
    if args.command in {"init", "project"}:
        if project_action is None:
            parser.exit(2, "Project service is not configured\n")
        action = "init" if args.command == "init" else args.project_command
        if action == "research":
            action = "research-" + args.research_command
        if action == "codex":
            action = "codex-" + args.codex_command
        if action == "session":
            action = "session-" + args.session_command
        values = {
            key: str(value)
            for key, value in vars(args).items()
            if key
            not in {
                "command",
                "project_command",
                "research_command",
                "codex_command",
                "session_command",
                "dry_run",
            }
            and value is not None
        }
        if "directory_option" in values:
            if "directory" in values:
                parser.error("use either directory or --directory, not both")
            values["directory"] = values.pop("directory_option")
        if getattr(args, "dry_run", False):
            action = "preview"
        try:
            project_result = project_action(action, values)
        except (OSError, ValueError, RuntimeError) as error:
            code = error.code if isinstance(error, ProjectError) else "project_io_error"
            parser.exit(
                2, json.dumps({"error": code, "message": str(error)}, ensure_ascii=False) + "\n"
            )
        print(json.dumps(project_result, ensure_ascii=False, indent=2))
        return 1 if project_result.get("status") == "needs_input" else 0
    if args.command == "web":
        if web_action is None:
            parser.exit(2, "Web service is not configured\n")
        try:
            return web_action(
                args.records_root,
                args.console_dir,
                args.web_root,
                tuple(args.task),
                args.port,
                args.state_dir,
            )
        except (OSError, ValueError) as error:
            parser.exit(2, f"Web startup failed: {error}\n")
    if args.command == "records":
        if records_action is None:
            parser.exit(2, "Records service is not configured\n")
        values = {
            key: value
            for key, value in vars(args).items()
            if key not in {"command", "records_command"} and value is not None
        }
        if isinstance(values.get("identifiers"), list):
            values["identifiers"] = json.dumps(values["identifiers"])
        try:
            result = records_action(
                args.records_command,
                {key: str(value) for key, value in values.items()},
            )
        except (OSError, RuntimeError, ValueError, KeyError) as error:
            parser.exit(2, f"Records error: {error}\n")
        print(json.dumps(result, sort_keys=True))
        return 0
    if args.command == "task":
        if task_action is None:
            parser.exit(2, "Task service is not configured\n")
        try:
            result = task_action(
                args.task_command,
                {
                    key: value
                    for key, value in vars(args).items()
                    if key not in {"command", "task_command"} and value is not None
                },
            )
        except (OSError, ValueError) as error:
            parser.exit(2, f"Task error: {error}\n")
        print(json.dumps(result, sort_keys=True))
        return 1 if result.get("status") == "needs_input" else 0
    if args.command == "config-check":
        try:
            config_result = check_config(args.config)
        except (OSError, ValueError) as error:
            parser.exit(2, f"Configuration error: {error}\n")
        print(json.dumps(config_result, sort_keys=True))
        return 0

    if args.command == "resource":
        try:
            if args.resource_command == "inspect":
                resource_result = inspect_resources()
            elif args.resource_command == "validate":
                resource_result = validate_resource_request(args.request)
            else:
                if gpu_action is None:
                    parser.exit(2, "GPU diagnostics are not configured\n")
                resource_result = gpu_action(args.resource_command, args)
        except (OSError, RuntimeError, ValueError) as error:
            parser.exit(2, f"Resource error: {error}\n")
        print(json.dumps(resource_result, sort_keys=True))
        return 1 if resource_result.get("ready") is False else 0

    try:
        callback = setup_agent if args.agent_command == "setup" else probe_agent
        agent_result = callback(args.provider)
    except (OSError, RuntimeError, ValueError) as error:
        parser.exit(2, f"Agent diagnostic error: {error}\n")
    print(json.dumps(agent_result, sort_keys=True))
    available = agent_result.get("available") is True
    compatible = agent_result.get("compatible", True) is True
    authentication_failed = agent_result.get("authenticated") is False
    return 0 if available and compatible and not authentication_failed else 1
