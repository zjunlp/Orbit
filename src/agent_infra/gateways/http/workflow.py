"""Narrow Web adapter: project reads and explicit controller actions, no execution engine."""

from collections.abc import Callable
from typing import Any

from agent_infra.projects.analysis import AnalysisService
from agent_infra.projects.console import ProjectConsole
from agent_infra.projects.sessions import SessionBindingStore
from agent_infra.runs.console import ConsoleService
from agent_infra.runs.control_api import SubmissionRequest
from agent_infra.runs.query import RunQueries
from agent_infra.runs.research_store import ResearchStore
from agent_infra.runs.review import ExperimentReviews
from agent_infra.runs.review_api import SessionList, SessionSummary


def analysis_summary(item: dict[str, Any]) -> dict[str, Any]:
    return {
        key: item[key]
        for key in (
            "analysis_id",
            "created_at",
            "observations",
            "interpretation",
            "uncertainty",
            "recommendation",
        )
    } | {
        "evidence": [
            {
                key: value
                for key, value in ref.items()
                if key
                in {
                    "run_id",
                    "artifact_id",
                    "member",
                    "metrics",
                    "data_version",
                    "code_version",
                }
            }
            for ref in item["evidence"]
        ]
    }


def run_summary(entry: dict[str, Any]) -> dict[str, Any]:
    """Never send controller requests, raw logs or private execution payloads to the browser."""
    result = entry.get("result")
    if result is not None and entry["request"].get("kind") == "command":
        result = result | {
            "execution_status": result.get("execution"),
            "evaluation_status": result.get("evaluation"),
            "archive_status": result.get("capture"),
            "lease_released": not entry.get("slot_held", False),
        }
    return {
        key: entry[key]
        for key in (
            "run_id",
            "attempt_id",
            "state",
            "cancel_requested",
            "created_at",
            "updated_at",
            "lineage",
        )
    } | {
        "kind": entry["request"].get("kind", "experiment"),
        "result": {
            key: value
            for key, value in (result or {}).items()
            if key
            in {
                "execution_status",
                "evaluation_status",
                "cleanup_complete",
                "lease_released",
                "status",
                "exit_code",
                "archive_status",
            }
        }
        if result is not None
        else None,
    }


class WorkflowGateway:
    def __init__(
        self,
        projects: ProjectConsole,
        console: ConsoleService,
        queries: RunQueries,
        jobs: ResearchStore,
        controller: Callable[[str, dict[str, Any] | None], dict[str, Any]],
        *,
        reviews: ExperimentReviews | None = None,
    ) -> None:
        self.projects, self.console, self.queries = projects, console, queries
        self.jobs, self.controller = jobs, controller
        self.analysis = AnalysisService(projects.store, queries)
        self.reviews = reviews
        self.sessions = SessionBindingStore(projects.store)

    def capabilities(self) -> dict[str, Any]:
        try:
            ready = self.controller("health", None).get("ready") is True
            reason = None if ready else "Controller 正在清理或隔离中，暂不能执行"
        except (OSError, ValueError):
            ready, reason = False, "Controller 未连接；用相同 --state-dir 启动 controller serve"
        return {
            "scope": "local_administrator",
            "project_workspaces": True,
            "run_control": ready,
            "artifact_download": True,
            "live_agent_trace": False,
            "controller_reason": reason,
            "providers": ["codex"] if ready else [],
        }

    def route(
        self,
        method: str,
        parts: list[str],
        query: dict[str, list[str]],
        body: dict[str, Any],
    ) -> object:
        if parts == ["capabilities"] and method == "GET":
            return self.capabilities()
        if parts == ["projects"] and method == "GET":
            return {"items": self.projects.list_projects(self.console.tasks())}
        if parts == ["projects", "init"] and method == "POST":
            return self.projects.initialize(body)
        if len(parts) >= 2 and parts[0] == "projects":
            identifier = parts[1]
            if method == "GET" and parts[2:3] == ["sessions"]:
                project_id = self.projects.workspace_id(identifier)
                bindings = self.sessions.list(project_id)
                if len(parts) == 3:
                    return SessionList(
                        project_id=project_id,
                        sessions=[
                            SessionSummary(
                                provider=item.provider,
                                session_id=item.session_id,
                                parent_session_id=item.parent_session_id,
                                started_at=item.started_at,
                                records_run_id=item.records_run_id,
                                records_attempt_id=item.records_attempt_id,
                                captured_lines=item.next_line,
                            )
                            for item in bindings
                        ],
                    ).model_dump(mode="json")
                if len(parts) == 5 and parts[4] == "events":
                    binding = next(
                        (item for item in bindings if item.records_run_id == parts[3]), None
                    )
                    if binding is None:
                        raise KeyError("session is not bound to this project")
                    return self.console.events(
                        binding.records_attempt_id, query.get("cursor", [None])[0]
                    )
                raise KeyError("unknown session route")
            if method == "GET" and len(parts) == 2:
                detail = self.projects.detail(identifier, self.console.tasks())
                target = detail["project"]["workspace_project_id"]
                if detail["research"] is not None:
                    detail["research"]["run_references"] = [
                        run_summary(r) for r in detail["research"]["run_references"]
                    ]
                detail["analyses"] = (
                    [analysis_summary(a) for a in self.analysis.list(target, "analysis")["items"]]
                    if target and detail["research"] is not None
                    else []
                )
                detail["runs"] = (
                    [run_summary(r) for r in self.queries.commands.list_runs(project_id=target)]
                    if target
                    else []
                )
                return detail
            if method == "POST" and parts[2:] == ["bind"]:
                return self.projects.bind(identifier, body)
            if method == "POST" and parts[2:] == ["compile"]:
                return self.projects.compiler.compile(
                    self.projects.workspace_id(identifier), **body
                )
            if method == "POST" and parts[2:] in (["preflight"], ["submit"]):
                return self.submit(identifier, body, submit=parts[2] == "submit")
        if parts == ["execution", "runs"] and method == "GET":
            offset = int(query.get("offset", ["0"])[0])
            rows = self.queries.commands.list_runs(limit=100, offset=offset)
            return {
                "items": [run_summary(r) for r in rows],
                "next_offset": offset + 100 if len(rows) == 100 else None,
            }
        if len(parts) >= 3 and parts[:2] == ["execution", "runs"]:
            run_id = parts[2]
            entry = self.queries.commands.get(run_id)
            if method == "GET":
                if parts[3:] == ["review"] and self.reviews is not None:
                    return self.reviews.get(run_id).model_dump(mode="json")
                if len(parts) == 3:
                    return run_summary(entry) | {
                        "jobs": [
                            {
                                key: job.get(key)
                                for key in (
                                    "job_id",
                                    "state",
                                    "exit_code",
                                    "created_at",
                                )
                            }
                            for job in self.jobs.jobs(run_id)
                        ],
                    }
                if parts[3:] == ["events"]:
                    return self.console.events(entry["attempt_id"], query.get("cursor", [None])[0])
                if parts[3:] == ["artifacts"]:
                    return {
                        "items": [
                            {
                                key: a[key]
                                for key in (
                                    "artifact_id",
                                    "name",
                                    "kind",
                                    "size_bytes",
                                    "media_type",
                                )
                            }
                            for a in self.queries.artifacts(run_id)
                        ]
                    }
                if len(parts) == 5 and parts[3] == "artifacts":
                    return self.queries.artifact(run_id, parts[4], query.get("member", [None])[0])
            if method == "POST" and parts[3:] == ["cancel"]:
                if entry["request"].get("kind") not in (None, "command"):
                    raise ValueError(
                        "请通过 research close、environment cancel 或 planner stop 结束"
                    )
                return run_summary(self.controller(f"runs/{run_id}/cancel", {}))
            if method == "POST" and parts[3:] == ["rerun"]:
                if entry["request"].get("kind") != "command":
                    raise ValueError("only direct command experiments support this rerun action")
                if set(body) != {"operation_id"}:
                    raise ValueError("rerun requires only operation_id")
                return run_summary(self.controller(f"runs/{run_id}/rerun", body))
        raise KeyError("unknown workflow route")

    def submit(self, identifier: str, body: dict[str, Any], *, submit: bool) -> dict[str, Any]:
        request = dict(body)
        operation = request.pop("operation_id", None)
        parsed = SubmissionRequest.from_dict(request)
        compiled = self.projects.compiler.resolve(parsed.task_id, parsed.task_revision)["compiled"]
        project = self.projects.workspace_id(identifier)
        context = self.projects.research.context(project)
        if compiled["project_id"] != project or (
            compiled["research_revision"] != context["accepted_revision"]
            or compiled["research_digest"] != context["accepted_digest"]
        ):
            raise ValueError("请选择当前已采用方案的实验；旧 Task 保留供查询")
        if submit:
            if not isinstance(operation, str) or not operation.strip():
                raise ValueError("提交需要 operation_id")
            # Durable controller idempotence handles double clicks and uncertain HTTP outcomes.
            return run_summary(self.controller("runs", request | {"operation_id": operation}))
        return self.controller("runs/preflight", request)
