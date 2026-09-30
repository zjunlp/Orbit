"""Disposable Planner sessions with external state and the shared resource allocator."""

import shutil
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from agent_infra.agents.api import (
    AgentPermissionMode,
    AgentPlacement,
    AgentRunRequest,
    InstallableCommandAgentAdapter,
)
from agent_infra.agents.codex import CodexAdapter
from agent_infra.agents.recording import agent_event_draft
from agent_infra.environments.api import InputMount, LogCursor, ProcessCommand, SandboxSpec
from agent_infra.environments.docker import DockerEnvironment
from agent_infra.records import (
    AttemptManifest,
    CaptureStatus,
    EventDraft,
    ProducerKind,
    RecordContext,
    RunManifest,
)
from agent_infra.resources.api import ResourceRequest
from agent_infra.runs.controller import LocalRunController
from agent_infra.runs.planner_bridge import PlannerBridge


class PlannerSessions:
    def __init__(
        self,
        control: LocalRunController,
        environment: DockerEnvironment,
        callback: Callable[[str, str, str, dict[str, Any]], dict[str, Any]],
        helper: Path,
        image: Callable[[str], str],
        connection: tuple[tuple[str, str], ...] | Callable[[], tuple[tuple[str, str], ...]] = (),
        adapter_factory: Callable[[str], InstallableCommandAgentAdapter] = lambda image: (
            CodexAdapter(container_image=image)
        ),
    ) -> None:
        self.control, self.env, self.callback = control, environment, callback
        self.helper, self.image, self.connection = helper, image, connection
        self.adapter_factory = adapter_factory
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._active: str | None = None

    def start(self, project: str, options: dict[str, Any], operation: str) -> dict[str, Any]:
        from agent_infra.runs.control_api import SubmissionRequest

        allowed = {
            "workflow_id",
            "model",
            "image",
            "timeout_seconds",
            "cpu",
            "memory_bytes",
            "prompt",
        }
        if set(options) - allowed:
            raise ValueError("unknown Planner option")
        workflow = options["workflow_id"]
        context = self.callback(project, workflow, "context", {})
        if context["workflow"]["state"] != "active":
            raise ValueError("Planner requires an active authorized workflow")
        # Reuse the model/time scalar validation; no task is submitted here.
        validated = SubmissionRequest.from_dict(
            {
                "task_id": workflow,
                "task_revision": workflow,
                "model": options["model"],
                "timeout_seconds": options.get("timeout_seconds", 300),
            }
        )
        if not isinstance(operation, str) or not 1 <= len(operation) <= 100:
            raise ValueError("Planner operation_id must have 1–100 characters")
        prompt = options.get(
            "prompt", "Continue the authorized experiments and analyze their results."
        )
        if not isinstance(prompt, str) or not 1 <= len(prompt) <= 16000:
            raise ValueError("Planner prompt must have 1–16000 characters")
        cpu, memory = options.get("cpu", 0.25), options.get("memory_bytes", 512 * 1024**2)
        if type(cpu) not in (int, float) or type(memory) is not int or memory < 64 * 1024**2:
            raise ValueError("invalid Planner resources")
        request = ResourceRequest("planner:" + operation, cpu, memory)
        image_id = self.image(options["image"])
        payload = options | {"kind": "planner", "image_id": image_id, "project_id": project}
        with self._lock:
            old = self.control.store.lookup("planner:" + project + ":" + operation, payload)
            if old:
                return old
            if self._active:
                raise ValueError("one Planner session is already running")
            lease = self.control.allocate_companion(request)
            try:
                entry = self.control.store.create(
                    "planner:" + project + ":" + operation,
                    payload,
                    {"project_id": project, "workflow_id": workflow},
                )
                self.control.store.update(entry["run_id"], lease_id=lease.lease_id)
                self._active = entry["run_id"]
                self._stop = threading.Event()
                self._thread = threading.Thread(
                    target=self._execute,
                    args=(
                        entry,
                        image_id,
                        validated.model,
                        validated.timeout_seconds,
                        prompt,
                        lease,
                    ),
                    daemon=False,
                    name="research-planner",
                )
                self._thread.start()
                return entry
            except Exception:
                self.control.release_companion(lease.lease_id, clean=True)
                self._active = None
                raise

    def _execute(
        self, entry: dict[str, Any], image: str, model: str, timeout: float, prompt: str, lease: Any
    ) -> None:
        run, attempt = entry["run_id"], entry["attempt_id"]
        root = self.control.store.path.parent / "planners" / run
        workspace, credential = (
            root / "workspace",
            self.control.store.path.parent / "credentials" / run,
        )
        handle = None
        clean, status = True, "failed"
        sink = None
        try:
            workspace.mkdir(parents=True, mode=0o700)
            now = datetime.now(UTC)
            self.control.records.begin_run(RunManifest(run, now, entry["request"]))
            self.control.records.begin_attempt(AttemptManifest(attempt, run, now))
            sink = self.control.records.scoped_sink(
                RecordContext(run, attempt, "planner:" + run, ProducerKind.AGENT)
            )
            sink.append_events((EventDraft("lease.granted", {"lease_id": lease.lease_id}),))
            adapter = self.adapter_factory(image)
            adapter.stage_container_credentials(credential)
            instructions = (
                "You are a research Planner. All authoritative state lives outside this container. "
                "Call python3 /inputs/planner-client.py context first. The helper accepts actions "
                "context, status, step, read, analysis with --json '<options>'. "
                "step takes task_key and stable operation_id; read takes run_id and optional "
                "artifact_id/member; poll status between experiments. Submit only tasks listed in "
                "workflow.tasks; do not run experiments in this Planner. Never invent metrics. "
                "Reuse prior action IDs and Run IDs. analysis takes operation_id and document "
                "with results [{run_id,artifact_id,member,metrics:[{name,pointer,unit,direction}],"
                "data_version,code_version}], observations,interpretation,uncertainty,"
                "recommendation. "
                "Missing information or out-of-scope tasks require a user decision. "
                "Do not authorize tasks, alter budgets, or access Docker.\n" + prompt
            )
            plan = adapter.create_launch_plan(
                AgentRunRequest(
                    run_id=run,
                    prompt=instructions,
                    workspace=workspace,
                    placement=AgentPlacement.CONTAINER,
                    model=model,
                    permission_mode=AgentPermissionMode.OUTER_SANDBOX,
                    reasoning_effort="low",
                ),
                credential_home=credential,
            )
            handle = self.env.prepare(
                SandboxSpec(
                    run,
                    "solver",
                    image,
                    workspace,
                    lease.cpu_cores,
                    lease.memory_bytes,
                    readonly_inputs=(InputMount(self.helper, "/inputs/planner-client.py"),),
                    private_home=credential,
                    home_target="/home/agent/.codex",
                    network=True,
                )
            )
            self.control.store.update(run, state="running", environment_id=handle.id)
            bridge = PlannerBridge(
                workspace,
                lambda action, options: self.callback(
                    entry["lineage"]["project_id"], entry["lineage"]["workflow_id"], action, options
                ),
            )
            self.env.start(
                handle,
                ProcessCommand(
                    plan.argv,
                    stdin_text=plan.stdin_text,
                    environment=plan.environment
                    + (self.connection() if callable(self.connection) else self.connection),
                    timeout_seconds=timeout,
                ),
            )
            cursor = LogCursor()
            for stream in ("stdout", "stderr"):
                sink.start_stream(run + ":" + stream, "planner/" + stream)
            offsets = {"stdout": 0, "stderr": 0}
            native_parts: list[str] = []
            truncated = False
            while True:
                if self._stop.is_set():
                    self.env.cancel(handle)
                observation = self.env.observe(handle, cursor)
                cursor = observation.cursor
                truncated = truncated or observation.logs_truncated
                native_parts.append(observation.stdout)
                for stream in offsets:
                    data = getattr(observation, stream).encode()
                    if data:
                        sink.append_stream(run + ":" + stream, data, offsets[stream])
                        offsets[stream] += len(data)
                event = bridge.poll()
                if event:
                    sink.append_events((EventDraft("planner.action", event),))
                if (
                    observation.status != "running"
                    and not observation.stdout
                    and not observation.stderr
                ):
                    status = (
                        "completed"
                        if observation.exit_code == 0
                        else ("cancelled" if self._stop.is_set() else "failed")
                    )
                    break
                time.sleep(0.1)
            streams = [
                sink.finalize_stream(
                    run + ":" + stream,
                    CaptureStatus.TRUNCATED if truncated else CaptureStatus.COMPLETE,
                )
                for stream in offsets
            ]
            raw_refs = tuple(stream.blob.digest for stream in streams if stream.blob is not None)
            native_sink = self.control.records.scoped_sink(
                RecordContext(run, attempt, "planner:native:" + run, ProducerKind.AGENT)
            )
            for native_event in adapter.decode_events(iter("".join(native_parts).splitlines())):
                native_sink.append_events((agent_event_draft(native_event, raw_refs),))
        except Exception as error:
            status = "failed"
            if sink:
                sink.append_events(
                    (EventDraft("planner.failed", {"error_type": type(error).__name__}),)
                )
        finally:
            try:
                if handle:
                    clean = self.env.cleanup(handle).complete
                if credential.exists():
                    shutil.rmtree(credential)
            except Exception:
                clean = False
            outcome = {
                "status": status,
                "cleanup_complete": clean,
                "lease_released": clean,
                "workflow_state_external": True,
            }
            try:
                self.control.release_companion(lease.lease_id, clean=clean)
                if sink:
                    self.control.records.finish_attempt(attempt, status=status, result=outcome)
                    self.control.records.finish_run(run, status=status)
                self.control.store.update(
                    run, state="finished" if clean else "quarantined", result=outcome
                )
            except Exception:
                self.control.release_companion(lease.lease_id, clean=False)
            finally:
                with self._lock:
                    self._active = None

    def stop(self, run_id: str) -> dict[str, Any]:
        with self._lock:
            if self._active == run_id:
                self._stop.set()
            return self.control.store.get(run_id)

    def close(self) -> bool:
        self._stop.set()
        if self._thread:
            self._thread.join(90)
        return self._active is None
