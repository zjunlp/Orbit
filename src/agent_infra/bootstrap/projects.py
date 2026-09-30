"""Local project composition and CLI defaults. No IO on import."""

import os
import sqlite3
from dataclasses import asdict
from pathlib import Path

from agent_infra.bootstrap.codex_capture import codex_session_action
from agent_infra.bootstrap.compilation import compilation_action
from agent_infra.bootstrap.paths import state_root
from agent_infra.bootstrap.research import research_action
from agent_infra.bootstrap.session_capture import session_action
from agent_infra.projects import InitRequest, ProjectError
from agent_infra.projects.local import LocalProjectStore
from agent_infra.projects.service import ProjectService


def project_action(action: str, options: dict[str, str]) -> dict[str, object]:
    try:
        store = LocalProjectStore(state_root(options.get("state_dir")) / "projects")
    except ValueError as error:
        raise ProjectError(str(error)) from error
    service = ProjectService(store)
    try:
        result: dict[str, object]
        if action in {"compile", "compiled-tasks", "resolve-task", "rebind"}:
            result = compilation_action(store, action, options)
        elif action.startswith("codex-"):
            result = codex_session_action(action.removeprefix("codex-"), options)
        elif action.startswith("session-"):
            result = session_action(action.removeprefix("session-"), options)
        elif action == "attach":
            result = {"project": service.attach(Path(options["identifier"])).to_dict()}
        elif action.startswith("research-"):
            result = research_action(store, action.removeprefix("research-"), options)
        elif action in {"init", "preview"}:
            root = options.get("root") or os.environ.get("AGENT_INFRA_PROJECTS_DIR")
            request = InitRequest(
                goal=options["goal"],
                directory=Path(options["directory"]) if "directory" in options else None,
                name=options.get("name"),
                root=Path(root) if root else None,
                operation_id=options.get("operation_id"),
            )
            if action == "preview":
                result = asdict(service.preview(request)) | {"dry_run": True}
            else:
                result = {"project": service.initialize(request).to_dict()}
        elif action == "list":
            result = {"projects": [p.to_dict() for p in store.list_projects()]}
        elif action in {"show", "recover"}:
            project = (
                service.get(options["identifier"])
                if action == "show"
                else service.recover(options["identifier"])
            )
            try:
                matches = service.projection_matches(project)
                workspace_error = None
            except (OSError, ProjectError) as error:
                matches, workspace_error = False, str(error)
            result = {
                "project": project.to_dict(),
                "manifest_matches": matches,
                "workspace_error": workspace_error,
            }
        else:
            raise ProjectError(f"unknown project action: {action}")
        return result | {"state_dir": str(store.root.parent)}
    except sqlite3.Error as error:
        raise ProjectError(f"project store unavailable: {error}") from error
