"""Research planning use cases. No model calls, task execution or resource allocation."""

from __future__ import annotations

import difflib
import hashlib
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from agent_infra.contracts.files import resolve_material
from agent_infra.projects import _filesystem as fs
from agent_infra.projects._compilation_store import CompilationStore
from agent_infra.projects.api import InitializationStatus, Project, ProjectConflict, ProjectError
from agent_infra.projects.local import LocalProjectStore
from agent_infra.projects.research_api import ResearchDraft, ResearchRevision
from agent_infra.projects.research_rendering import render_research
from agent_infra.projects.service import ProjectService
from agent_infra.projects.skill import install_research_skill, research_skill
from agent_infra.resources import load_resource_request


def load_research_draft(path: Path) -> ResearchDraft:
    path = fs.absolute(path)
    with fs.directory(path.parent) as parent:
        return ResearchDraft(fs.read_file(parent, path.name).decode("utf-8"))


class ResearchService:
    def __init__(
        self,
        store: LocalProjectStore,
        *,
        run_references: Callable[[str], list[dict[str, Any]]] | None = None,
    ) -> None:
        self.run_references = run_references
        self.store = store
        self.projects = ProjectService(store)

    def skill(self, identifier: str, *, install: bool = False) -> dict[str, Any]:
        project = self._project(identifier)
        if not install:
            return {"files": research_skill()}
        with self.store.writer():
            with fs.directory(Path(project.workspace)) as root:
                self.projects._check_identity(root, ".", project)
            return {"skill_path": install_research_skill(project)}

    def _project(self, identifier: str) -> Project:
        project = self.projects.get(identifier)
        if project.initialization != InitializationStatus.READY:
            raise ProjectConflict("recover project initialization before planning")
        return project

    def save(
        self, identifier: str, draft: ResearchDraft, *, expected_revision: int, reason: str
    ) -> dict[str, Any]:
        project = self._project(identifier)
        with self.store.writer():
            return self._save(project, draft, expected_revision, reason)

    def _save(
        self,
        project: Project,
        draft: ResearchDraft,
        expected_revision: int,
        reason: str,
        imported: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        if self.store.get(project.project_id).request.get("mode") == "attached":
            raise ProjectConflict(
                "attached workspaces keep Agent-managed documents; use an init-created project "
                "for the optional managed research-plan workflow"
            )
        saved = self.store.save_research(
            project.project_id,
            draft,
            expected_revision=expected_revision,
            reason=reason,
            files=render_research(project, draft, expected_revision + 1),
            imported=imported,
        )
        return {"saved": True, "research": saved.to_dict(), "projection": self._export(project)}

    def show(self, identifier: str, revision: int | None = None) -> dict[str, Any]:
        project = self._project(identifier)
        saved = (
            self.store.research_revision(project.project_id, revision)
            if revision is not None
            else self.store.research_state(project.project_id)["latest"]
        )
        return {"research": saved.to_dict() if saved else None}

    def confirm(
        self, identifier: str, *, revision: int, digest: str, decision: str
    ) -> dict[str, Any]:
        project = self._project(identifier)
        with self.store.writer():
            return self.store.confirm_research(
                project.project_id, revision=revision, digest=digest, decision=decision
            )

    def history(
        self, identifier: str, *, limit: int = 20, before: int | None = None
    ) -> list[dict[str, Any]]:
        return self.store.research_history(
            self._project(identifier).project_id, limit=limit, before=before
        )

    def diff(self, identifier: str, before: int, after: int) -> dict[str, Any]:
        project = self._project(identifier)
        old = self.store.research_revision(project.project_id, before)
        new = self.store.research_revision(project.project_id, after)

        def lines(item: ResearchRevision) -> list[str]:
            return (
                json.dumps(item.draft.to_dict(), indent=2, ensure_ascii=False, sort_keys=True)
                + "\n"
            ).splitlines(keepends=True)

        return {
            "from_revision": before,
            "to_revision": after,
            "diff": "".join(
                difflib.unified_diff(
                    lines(old),
                    lines(new),
                    fromfile=f"revision-{before}",
                    tofile=f"revision-{after}",
                )
            ),
        }

    def context(self, identifier: str) -> dict[str, Any]:
        project = self._project(identifier)
        state = self.store.research_state(project.project_id)
        latest, accepted = state["latest"], state["accepted"]
        document = (
            latest.draft.to_dict()
            if latest
            else ResearchDraft.from_dict({"schema_version": 1}).to_dict()
        )
        return {
            "project": project.to_dict(),
            "research_revision": latest.revision if latest else 0,
            "digest": latest.draft.digest if latest else None,
            "document": document,
            "accepted_revision": accepted.revision if accepted else None,
            "accepted_digest": accepted.draft.digest if accepted else None,
            "confirmation": state["confirmation"],
            "unaccepted_changes": bool(
                latest and (not accepted or latest.revision != accepted.revision)
            ),
            "projection_pending": state["pending"] is not None,
            "open_questions": document["brief"]["unknowns"],
            "next_step": document["next_step"],
            "run_references": self.run_references(project.project_id)
            if self.run_references
            else [],
            "execution_links_supported": self.run_references is not None,
            "compiled_tasks": [
                item.to_dict()
                for item in CompilationStore(self.store.database).list(project.project_id, limit=5)
            ],
            "recent_changes": self.store.research_history(
                project.project_id, limit=5, before=latest.revision + 1 if latest else 1
            ),
        }

    def check(self, identifier: str, revision: int | None = None) -> dict[str, Any]:
        project = self._project(identifier)
        saved = self.show(identifier, revision)["research"]
        if saved is None:
            return {
                "issues": [{"field": "research", "message": "No research draft saved."}],
                "execution_validated": False,
            }
        doc = saved["document"]
        issues: list[dict[str, str]] = []

        def issue(field: str, message: str) -> None:
            issues.append({"field": field, "message": message})

        if not doc["brief"]["question"]:
            issue("brief.question", "Research question is not specified.")
        for unknown in doc["brief"]["unknowns"]:
            issue("brief.unknowns", unknown)
        if not doc["plan"]["experiments"]:
            issue("plan.experiments", "No experiment planned yet.")
        with fs.directory(Path(project.workspace)):
            for experiment in doc["plan"]["experiments"]:
                field = f"experiments.{experiment['id']}"
                for name in ("method", "outputs", "stopping_condition"):
                    if not experiment[name]:
                        issue(f"{field}.{name}", "Not specified.")
                if not experiment["metrics"]:
                    issue(
                        f"{field}.metrics",
                        "No metrics; manual inspection is allowed if intentional.",
                    )
                for item in experiment["inputs"]:
                    try:
                        path = resolve_material(Path(project.workspace), item["path"])
                        if not path.exists() or not (path.is_file() or path.is_dir()):
                            raise ValueError("input file/directory is missing")
                    except (ValueError, OSError) as error:
                        issue(f"{field}.inputs", f"{item['path']}: {error}")
                    if not item["version"]:
                        issue(f"{field}.inputs", f"{item['path']}: data version not specified")
                resource = experiment["resource_request"]
                if resource:
                    try:
                        path = resolve_material(Path(project.workspace), resource)
                        if not path.is_file():
                            raise ValueError("resource request must be a regular file")
                        load_resource_request(path)
                    except (ValueError, OSError) as error:
                        issue(f"{field}.resource_request", str(error))
                else:
                    issue(
                        f"{field}.resource_request",
                        "Resource request not specified; no resources allocated.",
                    )
            for claim in doc["claims"]:
                for reference in claim["references"]:
                    if reference.startswith(("https://", "http://")):
                        continue  # Never fetch a URL or claim to have checked its content.
                    try:
                        if not resolve_material(Path(project.workspace), reference).is_file():
                            raise ValueError("reference file is missing")
                    except (ValueError, OSError) as error:
                        issue("claims.references", f"{reference}: {error}")
        return {
            "revision": saved["revision"],
            "digest": saved["digest"],
            "issues": issues,
            "execution_validated": False,
            "source_truth_verified": False,
        }

    def export(self, identifier: str) -> dict[str, Any]:
        project = self._project(identifier)
        with self.store.writer():
            return self._export(project)

    def _export(self, project: Project) -> dict[str, Any]:
        state = self.store.research_state(project.project_id)
        latest = state["latest"]
        if latest is None:
            return {"status": "not_started", "conflicts": []}
        desired = state["pending"] or render_research(project, latest.draft, latest.revision)
        conflicts = []
        try:
            with fs.directory(Path(project.workspace)) as root:
                self.projects._check_identity(root, ".", project)
                with fs.child_directory(root, "docs") as parent:
                    for path, content in desired.items():
                        try:
                            current = fs.read_file(parent, Path(path).name)
                            if current != content.encode():
                                if (
                                    hashlib.sha256(current).hexdigest()
                                    not in state["published"][path]
                                ):
                                    raise ProjectConflict(
                                        "user-edited file; import notes or keep this file"
                                    )
                                fs.write_file(
                                    parent, Path(path).name, content.encode(), replace=True
                                )
                        except (OSError, ProjectError) as error:
                            conflicts.append({"path": path, "message": str(error)})
        except (OSError, ProjectError) as error:
            conflicts.append({"path": project.workspace, "message": str(error)})
        if not conflicts and state["pending"] is not None:
            self.store.finish_research_export(project.project_id, latest.revision)
        return {
            "status": "pending" if conflicts else "ready",
            "revision": latest.revision,
            "conflicts": conflicts,
        }

    def import_notes(
        self, identifier: str, source: Path, *, section: str, expected_revision: int, reason: str
    ) -> dict[str, Any]:
        sections = {
            "background": ("brief", "background", "docs/background.md"),
            "question": ("brief", "question", "docs/research-goal.md"),
            "plan": ("plan", "summary", "docs/research-plan.md"),
        }
        if section not in sections:
            raise ProjectError("section must be background, question or plan")
        project = self._project(identifier)
        source = fs.absolute(source)
        with self.store.writer():
            with fs.directory(source.parent) as parent:
                text = fs.read_file(parent, source.name).decode("utf-8")
            state = self.store.research_state(project.project_id)
            latest = state["latest"]
            doc: dict[str, Any] = (
                latest.draft.to_dict() if latest else {"schema_version": 1, "brief": {}, "plan": {}}
            )
            group, field, projection = sections[section]
            doc[group][field] = text
            imported = (
                {projection: text} if source == Path(project.workspace) / projection else None
            )
            return self._save(
                project, ResearchDraft.from_dict(doc), expected_revision, reason, imported
            )
