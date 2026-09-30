"""Compatibility facade for the provider-neutral session store."""

from dataclasses import dataclass

from agent_infra.projects.local import LocalProjectStore
from agent_infra.projects.sessions import SessionBinding, SessionBindingStore


@dataclass(frozen=True)
class CodexBinding:
    thread_id: str
    project_id: str
    started_at: str
    cwd: str
    next_offset: int
    next_line: int


def _legacy(binding: SessionBinding) -> CodexBinding:
    return CodexBinding(
        binding.session_id,
        binding.project_id,
        binding.started_at,
        binding.cwd,
        binding.next_offset,
        binding.next_line,
    )


class CodexBindingStore:
    def __init__(self, projects: LocalProjectStore) -> None:
        self.store = SessionBindingStore(projects)

    def get(self, thread_id: str) -> CodexBinding | None:
        binding = self.store.get("codex", thread_id)
        return _legacy(binding) if binding else None

    def bind(self, thread_id: str, project_id: str, started_at: str, cwd: str) -> CodexBinding:
        return _legacy(
            self.store.bind(SessionBinding("codex", thread_id, project_id, started_at, cwd))
        )

    def advance(
        self, thread_id: str, expected_offset: int, next_offset: int, next_line: int
    ) -> None:
        binding = self.store.get("codex", thread_id)
        if binding is None:
            raise ValueError("Codex session is not bound")
        self.store.advance(binding, expected_offset, next_offset, next_line, None)
