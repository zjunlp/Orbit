"""Keep host-wide resource accounting out of users' real node state in unit tests."""

import pytest


@pytest.fixture(autouse=True)
def isolated_node_state(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_INFRA_NODE_STATE", str(tmp_path / "node-state"))
