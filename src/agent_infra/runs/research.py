"""Project-bound research use case; owns leases and Jobs, never MCP connections."""

import base64
import hashlib
import threading
import uuid
from collections.abc import Callable
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Any

from agent_infra.environments.api import EnvironmentHandle, SandboxSpec
from agent_infra.environments.job_api import JobSpec, ResearchEnvironment
from agent_infra.records.api import (
    AttemptManifest,
    CaptureStatus,
    EventDraft,
    RecordSink,
    RunManifest,
    Visibility,
)
from agent_infra.records.local import LocalRecordsStore
from agent_infra.resources.api import ResourceRequest
from agent_infra.runs.control_api import ControlError
from agent_infra.runs.controller import LocalRunController
from agent_infra.runs.environment_preparation import EnvironmentPreparation
from agent_infra.runs.query import RunQueries
from agent_infra.runs.research_evidence import ResearchEvidence
from agent_infra.runs.research_store import ResearchStore

_MUTATIONS = {
    "open",
    "close",
    "start",
    "stop",
    "write",
    "archive",
    "import_trace",
    "environment_plan",
    "environment_propose",
    "environment_build",
    "environment_cancel",
}


class ResearchController:
    def __init__(
        self,
        controller: LocalRunController,
        store: ResearchStore,
        environment: ResearchEnvironment,
        records: LocalRecordsStore,
        context: Callable[[str], dict[str, Any]],
        image: Callable[[str], str],
        import_trace: Callable[[RecordSink, dict[str, Any]], dict[str, Any]],
        preparation: EnvironmentPreparation | None = None,
        study: Callable[[str, str, dict[str, Any], str | None], dict[str, Any]] | None = None,
    ) -> None:
        self.study = study
        self.preparation = preparation
        self.control, self.store, self.env, self.records = controller, store, environment, records
        self.context, self.image, self.import_trace = context, image, import_trace
        self.queries = RunQueries(controller.store, records)
        self.evidence = ResearchEvidence(records, store, environment)
        self._lock = threading.RLock()
        self._stop = threading.Event()
        # D04 has already reconciled owned containers before this constructor.
        for job in self.store.pending_jobs():
            run = self.control.store.get(job["run_id"])
            if job["state"] in {"accepted", "running"}:
                job.update(state="interrupted", capture_status="partial")
                self.store.save_job(job)
            self.evidence.finalize_log(run, job, CaptureStatus(job["capture_status"]))
        self._thread = threading.Thread(target=self._watch, name="research-jobs", daemon=True)
        self._thread.start()

    def bind(self, project_id: str, session_id: str) -> dict[str, Any]:
        self._identifier(session_id)
        context = self.context(project_id)
        project_id = str(context["project"]["project_id"])
        return {
            "binding": self.store.bind(project_id, session_id),
            "project_id": project_id,
            "session_id": session_id,
        }

    @staticmethod
    def _identifier(value: str) -> None:
        if (
            not isinstance(value, str)
            or not 1 <= len(value) <= 128
            or any(ord(c) < 32 for c in value)
        ):
            raise ValueError("identifier must have 1–128 printable characters")

    def _run(self, project_id: str, run_id: str) -> dict[str, Any]:
        run = self.control.store.get(run_id)
        if (
            run["lineage"].get("project_id") != project_id
            or run["request"].get("kind") != "research"
        ):
            raise KeyError("research Run not found in bound project")
        return run

    def call(
        self, token: str, action: str, options: dict[str, Any], operation_id: str | None = None
    ) -> dict[str, Any]:
        with self._lock:
            project, session = self.store.binding(token)
            if action.startswith("study_"):
                if self.study is None:
                    raise ValueError("study service is not configured")
                return self.study(project, action, options, operation_id)
            if action == "context":
                return self.context(project) | {
                    "research_runs": [
                        r
                        for r in self.control.store.list_runs(project_id=project)
                        if r["request"].get("kind") == "research"
                    ]
                }
            if action in {"status", "events", "trajectory", "artifacts", "artifact"}:
                target = self.control.store.get(options["run_id"])
                if target["lineage"].get("project_id") != project:
                    raise KeyError("Run not found in bound project")
                if target["request"].get("kind") == "command":
                    return self.queries.read(action, options["run_id"], options)
            run = (
                self._run(project, options["run_id"])
                if action != "open" and not action.startswith("environment_")
                else None
            )
            key = None
            if action in _MUTATIONS:
                self._identifier(operation_id)  # type: ignore[arg-type]
                key = hashlib.sha256(f"{project}:{session}:{operation_id}".encode()).hexdigest()
                old = self.store.begin(key, {"action": action, "options": options})
                if old is not None:
                    return old
            call_id = key or uuid.uuid4().hex
            if run:
                self.evidence.event(
                    run,
                    session,
                    call_id,
                    "tool.requested",
                    {"tool_name": action, "arguments": options},
                )
            try:
                result = self._dispatch(project, session, action, options, key)
            except Exception as error:
                # Stable failure receipts ensure lost replies never replay a mutation.
                result = {"error": type(error).__name__, "message": str(error)}
            if action == "open" and result.get("run_id"):
                run = self._run(project, result["run_id"])
                self.evidence.event(
                    run,
                    session,
                    call_id,
                    "tool.requested",
                    {"tool_name": action, "arguments": options},
                )
            if run:
                self.evidence.event(
                    run, session, call_id, "tool.completed", {"tool_name": action, "result": result}
                )
            if key:
                self.store.finish(key, result)
            return result

    def _dispatch(
        self, project: str, session: str, action: str, options: dict[str, Any], key: str | None
    ) -> dict[str, Any]:
        if action.startswith("environment_"):
            if self.preparation is None:
                raise ValueError("environment preparation is not configured")
            return self.preparation.call(project, session, action, options, key)
        if action == "open":
            return self._open(project, session, options, str(key))
        run = self._run(project, options["run_id"])
        if action == "status":
            return run | {"jobs": self.store.jobs(run["run_id"])}
        if action in {"events", "trajectory", "artifacts", "artifact"}:
            return self.queries.read(action, run["run_id"], options)
        if action == "import_trace":
            return self.import_trace(
                self.evidence.native_sink(run, session), options | {"project_id": project}
            )
        if action == "logs":
            job = self.store.job(run["run_id"], options["job_id"])
            cursor = options.get("cursor", 0)
            path = self.evidence.log_path(job)
            size = path.stat().st_size if path.exists() else 0
            if type(cursor) is not int or not 0 <= cursor <= size:
                raise ValueError("invalid cursor")
            data = b""
            if path.exists():
                with path.open("rb") as file:
                    file.seek(cursor)
                    data = file.read(65536)
            return job | {
                "text": data.decode(errors="replace"),
                "content_base64": base64.b64encode(data).decode(),
                "next_cursor": cursor + len(data),
            }
        if action == "close":
            return self._close(run)
        if run["state"] != "running":
            raise ControlError("not_running", "environment is not running; inspect its status")
        handle = EnvironmentHandle(run["environment_id"])
        if action == "start":
            job_id = uuid.uuid4().hex
            spec = JobSpec(
                job_id,
                tuple(options["argv"]),
                options.get("cwd", "."),
                options.get("timeout_seconds", 3600),
            )
            job = {
                "job_id": job_id,
                "run_id": run["run_id"],
                "request": asdict(spec),
                "state": "accepted",
                "cursor": 0,
                "session_id": session,
                "tool_call_id": key,
                "capture_status": "partial",
            }
            self.store.save_job(job)
            self.evidence.sink(run).start_stream(
                job_id, f"job/{job_id}/combined", visibility=Visibility.USER
            )
            try:
                result = self.env.start_job(handle, spec)
            except ValueError:
                job.update(state="rejected")
                self.store.save_job(job)
                self.evidence.finalize_log(run, job, CaptureStatus.COMPLETE)
                raise
            job.update(result)
            self.store.save_job(job)
            return job
        if action == "stop":
            job = self.store.job(run["run_id"], options["job_id"])
            if job["state"] in {"accepted", "running"}:
                self.env.job(handle, job["job_id"], stop=True)
                self.evidence.poll(run, job)
            return self.store.job(run["run_id"], job["job_id"])
        if action in {"read", "write", "list", "archive"}:
            extra = (
                {"text": options["text"]}
                if action == "write"
                else {"offset": options.get("offset", 0)}
            )
            result = self.env.file(
                handle, "artifact" if action == "archive" else action, options["path"], **extra
            )
            if action == "archive":
                path = self.store.root / ("artifact-" + uuid.uuid4().hex)
                try:
                    path.write_bytes(base64.b64decode(result["content_base64"], validate=True))
                    artifact = self.evidence.sink(run).commit_artifact(path, name=options["path"])
                    return asdict(artifact)
                finally:
                    path.unlink(missing_ok=True)
            return result
        raise ValueError("unknown research action")

    def _open(
        self, project: str, session: str, options: dict[str, Any], key: str
    ) -> dict[str, Any]:
        lock = None
        if options.get("environment_lock"):
            if self.preparation is None:
                raise ValueError("environment preparation is not configured")
            lock = self.preparation.resolve(project, options["environment_lock"])
            if options.get("image") and options["image"] != lock["image_id"]:
                raise ValueError("image does not match environment lock")
            image = lock["image_id"]
        else:
            image = self.image(options["image"])
        cpu, memory = options.get("cpu", 1), options.get("memory_bytes", 2 * 1024**3)
        if type(cpu) not in (int, float) or type(memory) is not int or memory < 6 * 1024**2:
            raise ValueError("invalid CPU or memory")
        request = ResourceRequest(key, cpu, memory)
        self.control.refresh()
        assessment = self.control.resources.assess(request)
        if assessment.shortages:
            raise ControlError(
                "resource_unavailable", "; ".join(s.reason for s in assessment.shortages)
            )
        run = self.control.reserve_research(
            "research:" + key,
            {
                "kind": "research",
                "image": image,
                "cpu": cpu,
                "memory_bytes": memory,
                "session_id": session,
                "environment_lock": lock,
            },
            project,
        )
        try:
            now = datetime.now(UTC)
            self.records.begin_run(
                RunManifest(run["run_id"], now, run["request"] | {"project_id": project})
            )
            self.records.begin_attempt(
                AttemptManifest(
                    run["attempt_id"],
                    run["run_id"],
                    now,
                    coverage={"host_agent": "partial", "platform_tools": "complete"},
                )
            )
            lease = self.control.resources.try_allocate(request).lease
            if lease is None:
                raise RuntimeError("resources changed during admission")
            run = self.control.store.update(run["run_id"], lease_id=lease.lease_id)
            workspace = self.store.root / "workspaces" / run["run_id"]
            workspace.mkdir(parents=True, mode=0o700)
            handle = self.env.prepare(SandboxSpec(key, "solver", image, workspace, cpu, memory))
            run = self.control.store.update(
                run["run_id"], state="running", environment_id=handle.id
            )
            self.evidence.sink(run).append_events(
                (
                    EventDraft("lease.granted", asdict(lease)),
                    EventDraft(
                        "environment.ready",
                        {"environment_id": handle.id, "workspace": "/workspace", "image": image},
                    ),
                )
            )
            return run
        except Exception:
            self.control.store.update(
                run["run_id"],
                state="quarantined",
                result={
                    "status": "failed",
                    "cleanup_complete": False,
                    "error": "environment creation failed; restart controller for owned cleanup",
                },
            )
            self.control.release_research(run["run_id"], clean=False)
            raise

    def _watch(self) -> None:
        while not self._stop.wait(0.25):
            with self._lock:
                for run in self.control.store.unfinished():
                    if run["request"].get("kind") != "research" or run["state"] != "running":
                        continue
                    try:
                        for job in self.store.jobs(run["run_id"]):
                            if job["state"] in {"accepted", "running"}:
                                self.evidence.poll(run, job)
                    except Exception:
                        self.control.store.update(
                            run["run_id"],
                            state="quarantined",
                            result={
                                "status": "runtime_unavailable",
                                "cleanup_complete": False,
                                "capture_status": "partial",
                            },
                        )
                        self.control.release_research(run["run_id"], clean=False)

    def _close(self, run: dict[str, Any]) -> dict[str, Any]:
        if run["state"] == "finished":
            return run
        if "environment_id" not in run:
            raise ValueError("environment creation incomplete; restart controller to reconcile")
        handle = EnvironmentHandle(run["environment_id"])
        for job in self.store.jobs(run["run_id"]):
            if job["state"] in {"accepted", "running"}:
                try:
                    self.env.job(handle, job["job_id"], stop=True)
                    self.evidence.poll(run, job)
                except Exception:
                    job.update(state="interrupted", capture_status="partial")
                    self.store.save_job(job)
                    self.evidence.finalize_log(run, job, CaptureStatus.PARTIAL)
        cleanup = self.env.cleanup(handle)
        result: dict[str, Any] = {
            "status": "completed" if cleanup.complete else "cleanup_failed",
            "cleanup_complete": cleanup.complete,
            "lease_released": False,
            "archive_complete": False,
        }
        if cleanup.complete:
            result["lease_released"] = self.control.resources.release(run["lease_id"])
            try:
                destination = self.store.root / "archives" / uuid.uuid4().hex
                destination.parent.mkdir(exist_ok=True)
                submission = self.env.collect(handle, destination)
                artifact = self.evidence.sink(run).commit_artifact(
                    submission.root, name="workspace"
                )
                result.update(archive_complete=True, artifact_id=artifact.artifact_id)
            except Exception as error:
                result.update(
                    status="archive_failed",
                    error=f"workspace retained in controller state ({type(error).__name__})",
                )
            self.records.finish_attempt(run["attempt_id"], status=result["status"], result=result)
            self.records.finish_run(run["run_id"], status=result["status"])
        self.control.release_research(run["run_id"], clean=cleanup.complete)
        return self.control.store.update(
            run["run_id"], state="finished" if cleanup.complete else "quarantined", result=result
        )

    def close(self) -> bool:
        self._stop.set()
        self._thread.join(20)
        with self._lock:
            for run in self.control.store.unfinished():
                if run["request"].get("kind") == "research":
                    try:
                        self._close(run)
                    except Exception:
                        return False
        return not self.control.resources.active_leases
