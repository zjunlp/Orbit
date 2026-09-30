"""Legacy catalog is a source, never a second production metadata writer."""

import hashlib

import pytest

from agent_infra.projects.catalog import ProjectCatalogBridge
from agent_infra.projects.local import LocalProjectStore
from agent_infra.records.catalog import CatalogConflict
from tests.fixtures.legacy_catalog import seed_catalog


def test_catalog_moves_writes_to_projects_and_keeps_old_file(tmp_path):
    legacy = tmp_path / "legacy/catalog.sqlite3"
    original = {"id": "old", "name": "Original", "task_keys": ["task"], "revision": 1}
    seed_catalog(legacy, [original], (("task", "task-v1", "digest"),))
    digest = hashlib.sha256(legacy.read_bytes()).hexdigest()
    projects = LocalProjectStore(tmp_path / "state/projects")
    bridge = ProjectCatalogBridge(projects, legacy)
    assert bridge.list_projects() == [original] and not projects.database.path.exists()
    bridge.bind("old", "workspace-id")
    changed = bridge.save(original | {"name": "Updated"}, expected_revision=1)
    assert changed["revision"] == 2
    assert bridge.task_identities()["task"]["revision"] == "digest"
    assert hashlib.sha256(legacy.read_bytes()).hexdigest() == digest
    reopened = ProjectCatalogBridge(projects, legacy)
    assert reopened.bindings() == {"old": "workspace-id"}
    assert reopened.list_projects() == [changed]
    with pytest.raises(CatalogConflict):
        reopened.save(original, expected_revision=1)
