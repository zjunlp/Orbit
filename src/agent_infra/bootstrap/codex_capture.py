"""Backward-compatible Codex CLI/notify entrypoint for native session capture."""

from typing import Any

from agent_infra.bootstrap.session_capture import session_action


def codex_session_action(action: str, options: dict[str, str]) -> dict[str, Any]:
    return session_action(action, options | {"provider": "codex"})
