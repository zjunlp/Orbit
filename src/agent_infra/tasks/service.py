"""Task preparation without model calls, process execution or implicit resource allocation."""

from __future__ import annotations

import json
import math
import shutil
from pathlib import Path
from typing import Any

import yaml

from agent_infra.resources.api import ResourceRequest
from agent_infra.resources.config import load_resource_request, parse_bytes
from agent_infra.tasks.api import (
    AgentTaskView,
    DraftReview,
    EvaluationPlan,
    FieldState,
    TaskDefinition,
    TaskIssue,
    TaskSection,
    TaskSnapshot,
    ToolRequirement,
    VisibleMaterial,
)
from agent_infra.tasks.manifest import (
    canonical,
    content_digest,
    freeze_task,
    mapping,
    only_keys,
    parse_task,
    relative_path,
    resolve_material,
    string,
    task_document,
    validate_task,
)


def build_agent_view(task: TaskDefinition) -> AgentTaskView:
    """Project only public fields; never serialize full material/source/provenance objects."""
    if validate_task(task):
        # Do not leak private material names or exception details to the solver.
        raise ValueError("task validation failed; consult controller diagnostics")
    materials = tuple(
        VisibleMaterial(
            item.id,
            item.role,
            item.kind,
            str(item.target),
            item.description,
            item.access,
            item.media_type,
        )
        for item in task.materials
        if "solver" in item.audiences
    )
    paths = {item.id: item.path for item in materials}
    return AgentTaskView(
        task.task_id,
        task.revision,
        tuple(paths[ref] for ref in task.instructions),
        tuple(paths[ref] for ref in task.user_context),
        materials,
        _public_outputs(task.outputs),
        required_tools(task),
    )


def required_tools(task: TaskDefinition) -> tuple[ToolRequirement, ...]:
    """Declared capabilities only. Environment must bind and verify them before execution."""
    if task.tools.state is FieldState.UNKNOWN:
        raise ValueError("task tools are unresolved")
    if task.tools.state is not FieldState.SPECIFIED:
        return ()
    return tuple(
        ToolRequirement(
            item["tool_id"], item["version"], item["required"], item["transport"], item["scope"]
        )
        for item in json.loads(task.tools.value_json)["items"]
    )


def _public_outputs(section: TaskSection) -> TaskSection:
    if section.state is not FieldState.SPECIFIED:
        return section
    body = json.loads(section.value_json)
    only_keys(body, {"items"}, "outputs")
    items = body.get("items")
    if not isinstance(items, list):
        raise ValueError("outputs.items must be a list")
    public = []
    for value in items:
        item = mapping(value, "output")
        only_keys(item, {"path", "required", "provenance"}, "output")
        path = string(item.get("path"), "output.path")
        relative_path(path)
        if type(item.get("required")) is not bool:
            raise ValueError("output.required must be a boolean")
        public.append({"path": path, "required": item["required"]})
    return TaskSection(FieldState.SPECIFIED, canonical({"items": public}))


def materialize_agent_view(
    task: TaskDefinition,
    snapshot: TaskSnapshot,
    destination: Path,
) -> AgentTaskView:
    """Copy into a NEW task-owned directory. This is preparation, not OS-level isolation."""
    if freeze_task(task) != snapshot:
        raise ValueError("task changed since snapshot")
    view = build_agent_view(task)
    destination = destination.absolute()
    if destination.exists() or destination.is_symlink():
        raise FileExistsError("destination must not exist")
    if destination.resolve().is_relative_to(task.root):
        raise ValueError("destination must be outside the source task root")
    destination.mkdir(mode=0o700, parents=True)
    try:
        for material in task.materials:
            if "solver" not in material.audiences:
                continue
            source = resolve_material(task.root, material.source)
            target = destination / str(material.target)
            target.parent.mkdir(parents=True, exist_ok=True)
            if material.kind == "directory":
                shutil.copytree(source, target, symlinks=True)
            else:
                shutil.copyfile(source, target, follow_symlinks=False)
            if content_digest(target) != dict(snapshot.material_digests)[material.id]:
                raise ValueError("material changed during copy")
        if freeze_task(task) != snapshot:
            raise ValueError("task changed during preparation")
        return view
    except BaseException:
        shutil.rmtree(destination)
        raise


def write_manifest(task: TaskDefinition, destination: Path) -> None:
    """Create a new manifest in the same root, never rewrite source files."""
    if destination.parent.resolve() != task.root:
        raise ValueError("manifest must stay in its source root; paths are relative")
    with destination.open("x", encoding="utf-8") as stream:
        yaml.safe_dump(task_document(task), stream, allow_unicode=True, sort_keys=False)


def create_research_draft(
    task_id: str, instruction: Path, *, data: Path | None = None
) -> TaskDefinition:
    root = instruction.parent.resolve()
    materials: list[dict[str, Any]] = []
    for identifier, path, role in (
        ("instruction", instruction, "instruction"),
        ("data", data, "data"),
    ):
        if path is None:
            continue
        resolved = path.absolute()
        if not resolved.is_relative_to(root):
            raise ValueError("draft materials must be within the instruction directory")
        materials.append(
            {
                "id": identifier,
                "role": role,
                "kind": "directory" if path.is_dir() else "file",
                "source": resolved.relative_to(root).as_posix(),
                "description": identifier,
                "audiences": ["solver", "evaluator", "controller"],
                "target": identifier if role == "data" else instruction.name,
                "access": "read_only",
                "availability": "present" if path.exists() else "needs_input",
                "provenance": {"origin": "user"},
            }
        )
    return parse_task(
        {
            "schema_version": 1,
            "task_id": task_id,
            "revision": "draft-1",
            "mode": "research",
            "source": {"kind": "user"},
            "instructions": ["instruction"],
            "materials": materials,
        },
        root=root,
    )


def review_draft(task: TaskDefinition) -> DraftReview:
    issues = list(validate_task(task))
    if task.mode == "research" and task.outputs.state in {
        FieldState.UNKNOWN,
        FieldState.UNSPECIFIED,
    }:
        issues.append(
            TaskIssue(
                "needs_output",
                "outputs",
                "Clarify the intended deliverable or explicitly record none",
            )
        )
    if task.mode == "research" and task.evaluation.state is FieldState.UNKNOWN:
        issues.append(
            TaskIssue(
                "needs_evaluation", "evaluation", "Clarify the unresolved evaluation requirement"
            )
        )
    for name in ("tools", "resource_intent", "environment", "execution_policy"):
        if getattr(task, name).state is FieldState.UNKNOWN:
            issues.append(TaskIssue("needs_clarification", name, "Resolve the unknown requirement"))
    return DraftReview("needs_input" if issues else "ready", tuple(issues))


def validate_resource_plan(task: TaskDefinition, request_file: Path) -> ResourceRequest:
    """Validate execution choices without modifying task requirements or granting a lease."""
    request = load_resource_request(request_file)
    intent = task.resource_intent
    if intent.state is FieldState.UNKNOWN:
        raise ValueError("resource requirements are unresolved")
    if intent.state is not FieldState.SPECIFIED:
        return request
    body = mapping(json.loads(intent.value_json), "resource_intent")
    only_keys(body, {"constraints", "provenance"}, "resource_intent")
    constraints = mapping(body.get("constraints"), "constraints")
    only_keys(
        constraints,
        {"cpu_min", "cpu_max", "memory_min", "memory_max", "gpu_min", "gpu_max"},
        "constraints",
    )
    for key, raw in constraints.items():
        amount = {
            "cpu": request.cpu_cores,
            "memory": request.memory_bytes,
            "gpu": request.gpu.count,
        }[key.split("_")[0]]
        if key.startswith("memory"):
            bound = float(parse_bytes(raw, key, allow_zero=True))
        else:
            if isinstance(raw, bool) or not isinstance(raw, int | float) or raw < 0:
                raise ValueError(f"invalid resource bound: {key}")
            bound = float(raw)
            if not math.isfinite(bound):
                raise ValueError(f"invalid resource bound: {key}")
        if (key.endswith("min") and amount < bound) or (key.endswith("max") and amount > bound):
            raise ValueError(f"resource request violates {key}")
    return request


def build_evaluation_plan(task: TaskDefinition, submission: Path) -> EvaluationPlan:
    if task.evaluation.state is not FieldState.SPECIFIED:
        raise ValueError("task has no configured automatic evaluator")
    body = mapping(json.loads(task.evaluation.value_json), "evaluation")
    only_keys(body, {"evaluator_ref", "audiences", "feedback"}, "evaluation")
    if set(body.get("audiences", [])) != {"evaluator", "controller"}:
        raise ValueError("private evaluation must be scoped to evaluator and controller")
    reference = string(body.get("evaluator_ref"), "evaluator_ref")
    feedback = string(body.get("feedback"), "feedback")
    if feedback not in {"none", "after_submission", "native"}:
        raise ValueError("invalid feedback policy")
    if not submission.is_dir() or submission.is_symlink():
        raise ValueError("submission must be a regular directory")
    return EvaluationPlan(
        reference,
        freeze_task(task),
        submission.resolve(),
        content_digest(submission),
        tuple(
            item.id
            for item in task.materials
            if "evaluator" in item.audiences and "solver" not in item.audiences
        ),
        feedback,
    )


def verify_evaluation_inputs(task: TaskDefinition, plan: EvaluationPlan) -> None:
    if (
        freeze_task(task) != plan.task_snapshot
        or content_digest(plan.submission_root) != plan.submission_digest
    ):
        raise ValueError("evaluation inputs changed; collect a new immutable submission")
