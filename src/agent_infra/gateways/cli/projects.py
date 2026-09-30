"""Project argument definitions; behavior is injected by the composition root."""

from __future__ import annotations

import argparse


def add_compilation_arguments(actions: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    for name in ("compile", "compiled-tasks", "resolve-task", "rebind"):
        entry = actions.add_parser(name)
        entry.add_argument("--state-dir", help="Control state root")
        if name == "resolve-task":
            entry.add_argument("task_id")
            entry.add_argument("--task-revision", required=True)
            continue
        entry.add_argument(
            "identifier", help="Project ID or current workspace path; rebind requires ID"
        )
        if name == "compile":
            entry.add_argument("--experiment", required=True)
            entry.add_argument(
                "--revision", type=int, required=True, help="Adopted research revision"
            )
            entry.add_argument("--execution", help="Project-relative execution settings YAML")
            entry.add_argument("--max-material-bytes", type=int, default=1024**3)
        elif name == "compiled-tasks":
            entry.add_argument("--limit", type=int, default=20)
            entry.add_argument("--offset", type=int, default=0)
        elif name == "rebind":
            entry.add_argument("--directory", required=True, help="Existing moved workspace")
            entry.add_argument("--expected-revision", required=True, type=int)


def add_init_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("directory", nargs="?", help="New project directory (must not exist)")
    parser.add_argument(
        "--directory", dest="directory_option", help="Alternative to positional directory"
    )
    parser.add_argument("--goal", required=True, help="Original research goal; saved verbatim")
    parser.add_argument(
        "--name", help="Display name; used for directory name when no path is supplied"
    )
    parser.add_argument("--root", help="Parent projects directory (default: environment or cwd)")
    parser.add_argument(
        "--state-dir", help="Control state root (default: environment or user state)"
    )
    parser.add_argument(
        "--operation-id", help="Idempotency key, especially for automatic directory names"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Preview files without writing anything"
    )


def add_research_arguments(parser: argparse.ArgumentParser) -> None:
    actions = parser.add_subparsers(dest="research_command", required=True)
    for name in (
        "save",
        "show",
        "history",
        "diff",
        "confirm",
        "context",
        "check",
        "export",
        "import-notes",
        "skill",
    ):
        entry = actions.add_parser(name)
        entry.add_argument("identifier", help="Project UUID or original workspace path")
        entry.add_argument("--state-dir", help="Control state root")
        if name in {"save", "import-notes"}:
            entry.add_argument("--file", required=True, help="UTF-8 JSON draft or Markdown notes")
            entry.add_argument(
                "--expected-revision",
                required=True,
                type=int,
                help="Current research revision, or 0 before the first save",
            )
            entry.add_argument("--reason", required=True, help="What changed and why")
        if name == "import-notes":
            entry.add_argument(
                "--section", choices=("background", "question", "plan"), required=True
            )
        if name in {"show", "check", "confirm"}:
            entry.add_argument("--revision", type=int, required=name == "confirm")
        if name == "confirm":
            entry.add_argument("--digest", required=True)
            entry.add_argument(
                "--decision",
                required=True,
                help="User choice or existing authorization being recorded",
            )
        if name == "history":
            entry.add_argument("--limit", type=int, default=20)
            entry.add_argument("--before", type=int)
        if name == "diff":
            entry.add_argument("--from-revision", required=True, type=int)
            entry.add_argument("--to-revision", required=True, type=int)
        if name == "skill":
            entry.add_argument(
                "--install", action="store_true", help="Install into this project's .agents/skills"
            )


def add_codex_session_arguments(parser: argparse.ArgumentParser) -> None:
    actions = parser.add_subparsers(dest="codex_command", required=True)
    for action in ("discover", "bind", "sync", "notify"):
        entry = actions.add_parser(action)
        if action != "notify":
            entry.add_argument("identifier", help="Project ID or current workspace path")
        entry.add_argument("--state-dir")
        if action in {"bind", "sync"}:
            entry.add_argument("thread_id", help="Codex thread ID from discover")
        if action != "discover":
            entry.add_argument("--max-lines", type=int, default=2000)
        if action == "notify":
            entry.add_argument("notification", help="JSON argument supplied by Codex notify")


def add_session_arguments(parser: argparse.ArgumentParser) -> None:
    actions = parser.add_subparsers(dest="session_command", required=True)
    for action in ("discover", "list", "bind", "sync"):
        entry = actions.add_parser(action)
        entry.add_argument("identifier", help="Project ID or workspace path")
        entry.add_argument("--provider", choices=("codex", "claude-code"), default="codex")
        entry.add_argument("--state-dir")
        if action in {"bind", "sync"}:
            entry.add_argument("session_id", help="Native session identity from discover")
            entry.add_argument("--max-lines", type=int, default=2000)
