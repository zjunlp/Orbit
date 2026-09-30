"""Console catalog contract; the project module owns persistence and legacy reads."""

from typing import Any, Protocol


class CatalogConflict(ValueError):
    """A concurrent edit changed the project revision."""


class ProjectCatalog(Protocol):
    def list_projects(self) -> list[dict[str, Any]]: ...

    def save(self, project: dict[str, Any], expected_revision: int) -> dict[str, Any]: ...

    def bindings(self) -> dict[str, str]: ...

    def bind(self, legacy_id: str, project_id: str) -> None: ...

    def remember_tasks(self, tasks: list[dict[str, Any]]) -> None: ...

    def task_identities(self) -> dict[str, dict[str, str]]: ...
