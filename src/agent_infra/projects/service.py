"""Local workspace initialization and recovery, without Agent or execution dependencies."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import Path
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

import yaml

from agent_infra.projects import _filesystem as fs
from agent_infra.projects.api import (
    InitializationStatus,
    InitPreview,
    InitRequest,
    Project,
    ProjectConflict,
    ProjectError,
)
from agent_infra.projects.local import LocalProjectStore, StoredProject
from agent_infra.projects.rendering import DIRECTORIES, manifest, render


def _read_manifest(parent: int) -> Project:
    try:
        doc = yaml.safe_load(fs.read_file(parent, "project.yaml"))
    except yaml.YAMLError as error:
        raise ProjectError("project.yaml is not valid YAML; inspect before recovering") from error
    if not isinstance(doc, dict):
        raise ProjectError("project.yaml must contain an object")
    return Project.from_dict(doc)


class ProjectService:
    def __init__(self, store: LocalProjectStore) -> None:
        self.store = store

    def attach(self, workspace: Path) -> Project:
        """Register an existing directory without adding files or inventing a research plan."""
        workspace = fs.absolute(workspace)
        with fs.directory(workspace):
            pass
        if workspace.is_relative_to(self.store.root) or self.store.root.is_relative_to(workspace):
            raise ProjectError("workspace and control state must not contain one another")
        with self.store.writer():
            old = self.store.find(workspace=str(workspace))
            if old is not None:
                return old.project
            now = datetime.now(UTC).isoformat()
            project = Project(
                str(uuid4()),
                "attach:" + str(uuid4()),
                workspace.name[:200],
                "Existing workspace; research goal not specified",
                str(workspace),
                now,
                now,
                initialization=InitializationStatus.READY,
            )
            self.store.reserve(StoredProject(project, {}, (), {"mode": "attached"}))
            return project

    def _proposal(self, request: InitRequest) -> StoredProject:
        operation = request.operation_id or str(uuid4())
        project_id = str(uuid5(NAMESPACE_URL, "agent-infra/project/" + operation))
        root = fs.absolute(request.root or Path.cwd())
        if request.directory is not None:
            path = request.directory.expanduser()
            workspace = fs.absolute(path if path.is_absolute() else root / path)
        else:
            slug = re.sub(r"[^\w-]+", "-", request.name or "", flags=re.UNICODE).strip("-_")
            if request.name is not None and not slug:
                raise ProjectError("name has no usable directory characters; specify a directory")
            workspace = root / (slug[:100] if slug else "project-" + project_id[:12])
        if request.root is not None and (workspace == root or not workspace.is_relative_to(root)):
            raise ProjectError("destination must be a child of the specified projects root")
        if workspace.is_relative_to(self.store.root) or self.store.root.is_relative_to(workspace):
            raise ProjectError("workspace and control state must not contain one another")
        # Pin/check the full parent chain even in preview; never follow symlinks.
        with fs.directory(workspace.parent):
            pass
        title = request.name or (
            workspace.name
            if request.directory is not None
            else request.goal.strip().splitlines()[0][:200]
        )
        now = datetime.now(UTC).isoformat()
        project = Project(project_id, operation, title, request.goal, str(workspace), now, now)
        normalized = {"title": title, "goal": request.goal, "workspace": str(workspace)}
        return StoredProject(project, render(project), DIRECTORIES, normalized)

    def _existing(
        self, candidate: StoredProject, *, explicit_operation: bool
    ) -> StoredProject | None:
        p = candidate.project
        found = self.store.find(
            operation=p.operation_id if explicit_operation else None, workspace=p.workspace
        )
        if found is not None:
            if found.request != candidate.request or (
                explicit_operation and found.project.operation_id != p.operation_id
            ):
                raise ProjectConflict(
                    "operation or destination already has different init parameters"
                )
        return found

    def preview(self, request: InitRequest) -> InitPreview:
        candidate = self._proposal(request)
        found = self._existing(candidate, explicit_operation=request.operation_id is not None)
        if found is None:
            workspace = Path(candidate.project.workspace)
            with fs.directory(workspace.parent) as parent:
                if fs.exists(parent, workspace.name):
                    raise ProjectConflict("destination already exists; choose a new directory")
        item = found or candidate
        return InitPreview(item.project, item.directories, dict(item.snapshot), found is not None)

    def initialize(self, request: InitRequest) -> Project:
        candidate = self._proposal(request)
        with self.store.writer():
            found = self._existing(candidate, explicit_operation=request.operation_id is not None)
            if found is None:
                workspace = Path(candidate.project.workspace)
                with fs.directory(workspace.parent) as parent:
                    if fs.exists(parent, workspace.name):
                        raise ProjectConflict("destination already exists; choose a new directory")
                self.store.reserve(candidate)
            return self._recover(found or candidate)

    def get(self, identifier: str) -> Project:
        """Accept an ID or the original workspace path; stored metadata stays authoritative."""
        try:
            UUID(identifier)
        except ValueError:
            pass
        else:
            return self.store.get(identifier).project
        workspace = fs.absolute(Path(identifier))
        attached = self.store.find(workspace=str(workspace))
        if attached is not None and attached.request.get("mode") == "attached":
            with fs.directory(workspace):
                pass
            return attached.project
        with fs.directory(workspace) as parent:
            identity = _read_manifest(parent)
        project = self.store.get(identity.project_id).project
        if project.workspace != str(workspace):
            raise ProjectConflict(
                "workspace moved; use project rebind with its ID and new directory"
            )
        return project

    def recover(self, identifier: str) -> Project:
        project = self.get(identifier)
        with self.store.writer():
            return self._recover(self.store.get(project.project_id))

    def _recover(self, item: StoredProject) -> Project:
        p = item.project
        if item.request.get("mode") == "attached":
            return p
        workspace = Path(p.workspace)
        stage = ".agent-infra-init-" + p.project_id
        with fs.directory(workspace.parent) as parent:
            if p.initialization == InitializationStatus.READY:
                self._check_identity(parent, workspace.name, p)
                return p  # Never regenerate user-edited research documents.
            if p.initialization == InitializationStatus.PROJECTION_PENDING:
                with fs.child_directory(parent, workspace.name) as child:
                    current = fs.read_file(child, "project.yaml")
                    expected = manifest(p).encode("utf-8")
                    if current != expected:
                        if current != item.snapshot["project.yaml"].encode("utf-8"):
                            raise ProjectConflict("project.yaml was edited; refusing to replace it")
                        fs.write_file(child, "project.yaml", expected, replace=True)
                return self.store.mark_ready(p.project_id, manifest(p))
            if fs.exists(parent, workspace.name):
                with fs.child_directory(parent, workspace.name) as child:
                    fs.verify(child, item.snapshot, item.directories)
            else:
                with fs.child_directory(parent, stage, create=True) as child:
                    fs.populate(child, item.snapshot, item.directories)
                fs.publish(parent, stage, workspace.name)
            return self.store.mark_ready(p.project_id, item.snapshot["project.yaml"])

    @staticmethod
    def _check_identity(parent: int, name: str, project: Project) -> None:
        with fs.child_directory(parent, name) as child:
            found = _read_manifest(child)
            if (found.project_id, found.operation_id, found.workspace) != (
                project.project_id,
                project.operation_id,
                project.workspace,
            ):
                raise ProjectConflict("workspace identity changed; inspect before recovering")

    def projection_matches(self, project: Project) -> bool | None:
        if self.store.get(project.project_id).request.get("mode") == "attached":
            return None  # Existing workspaces deliberately have no managed manifest.
        with fs.directory(Path(project.workspace)) as parent:
            return fs.read_file(parent, "project.yaml") == manifest(project).encode("utf-8")
