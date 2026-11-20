"""Revalidate the aggregate vla-eval wrote in the solve output (read-only, no network)."""

import hashlib
import json
import os
from pathlib import Path
import sys

STRUCTURED_RECEIPT_ARG = "--structured"


def summarize(out: Path, *, suite=None, task_id=None) -> dict:
    """The one episode vla-eval exported for this trial, and which initial state it ran."""
    files = sorted(out.glob("*_aggregate.json"))
    if len(files) != 1:
        raise ValueError(f"expected one vla-eval aggregate json, found {len(files)}")
    payload = files[0].read_bytes()
    agg = json.loads(payload)
    tasks = agg.get("tasks") or []
    episodes = [(task, episode) for task in tasks for episode in task.get("episodes", [])]
    if len(episodes) != 1:
        raise ValueError(f"a trial is one episode, the aggregate has {len(episodes)}")
    task, ep = episodes[0]
    outer, inner = task.get("task"), ep.get("name")
    task_name = outer or inner
    if not isinstance(task_name, str) or not task_name:
        raise ValueError("the aggregate has no task identity")
    params = (agg.get("config") or {}).get("params") or {}
    if suite is not None:
        if len(tasks) != 1 or inner != task_name or outer != task_name:
            raise ValueError("aggregate task name differs from the episode")
        if ep.get("suite") != suite or params.get("suite", suite) != suite:
            raise ValueError("aggregate suite differs from the planned LIBERO task")
        native_id = ep.get("task_id")
        if type(native_id) is not int or native_id < 0 or (
                task_id is not None and (native_id != task_id or params.get("orbit_task_id") != task_id)):
            raise ValueError("aggregate task ID differs from the planned LIBERO task")
    error = ep.get("failure_reason")
    if error is not None and not isinstance(error, str):
        raise ValueError("invalid upstream failure reason")
    success = (ep.get("metrics") or {}).get("success", 0 if error else None)
    if type(success) not in (bool, int, float) or success not in (0, 1):
        raise ValueError("the episode success metric must be binary")
    steps = ep.get("steps")
    if type(steps) is not int or steps < 0:
        raise ValueError("the episode step count must be a nonnegative integer")
    episode = params.get("orbit_episode")
    if type(episode) is not int or episode < 0:
        raise ValueError("the aggregate must record a nonnegative initial-state ordinal")
    return {
        "benchmark": agg.get("benchmark", ""),
        "task": task_name,
        **({"aggregateDigest": "sha256:" + hashlib.sha256(payload).hexdigest()} if suite is not None else {}),
        "episode": episode,
        "steps": steps,
        "success": float(success),
        "errors": 1 if error else 0,
        **({"failureReason": error} if error else {}),
        "issues": [f"the episode errored upstream ({error}); vla-eval counts it as a failure"]
        if error
        else [],
    }


def main() -> int:
    try:
        if len(sys.argv) not in (2, 3, 4):
            raise ValueError("usage: check.py OUTPUT [--structured | SUITE [TASK_ID]]")
        identity = sys.argv[2:]
        if identity == [STRUCTURED_RECEIPT_ARG]:
            identity = []
        body = summarize(Path(sys.argv[1]), suite=identity[0] if identity else None,
                         task_id=int(identity[1]) if len(identity) == 2 else None)
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    dest = Path(os.environ.get("ORBIT_OUTPUT", ".")) / "check.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(body, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
