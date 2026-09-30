"""Legacy catalog is a source, never a second production metadata writer."""

import hashlib

import pytest

from agent_infra.projects.catalog import ProjectCatalogBridge
from agent_infra.projects.local import LocalProjectStore
from agent_infra.records.catalog import CatalogConflict, LocalProjectCatalog


def test_catalog_moves_writes_to_projects_and_keeps_old_file(tmp_path):
    legacy = LocalProjectCatalog(tmp_path / "legacy/catalog.sqlite3")
    original = legacy.save({"id": "old", "name": "Original", "task_keys": ["task"]}, 0)
    legacy.remember_tasks([{"key": "task", "task_id": "task-v1", "revision": "digest"}])
    digest = hashlib.sha256(legacy.path.read_bytes()).hexdigest()
    projects = LocalProjectStore(tmp_path / "state/projects")
    bridge = ProjectCatalogBridge(projects, legacy.path)
    assert bridge.list_projects() == [original] and not projects.database.path.exists()
    bridge.bind("old", "workspace-id")
    changed = bridge.save(original | {"name": "Updated"}, expected_revision=1)
    assert changed["revision"] == 2
    assert bridge.task_identities()["task"]["revision"] == "digest"
    assert hashlib.sha256(legacy.path.read_bytes()).hexdigest() == digest
    assert legacy.list_projects() == [original]
    reopened = ProjectCatalogBridge(projects, legacy.path)
    assert reopened.bindings() == {"old": "workspace-id"}
    assert reopened.list_projects() == [changed]
    with pytest.raises(CatalogConflict):
        reopened.save(original, expected_revision=1)
