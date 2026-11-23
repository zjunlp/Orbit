"""Revalidate the aggregate vla-eval wrote in the solve output (read-only, no network)."""

import hashlib
import json
import math
import os
from pathlib import Path
import sys

STRUCTURED_RECEIPT_ARG = "--structured"
BINARY_SCORE_ARG = "--binary-score"
RESOLVED_SUITE_ARG = "--resolved-suite"
TASK_IDENTITY_ARG = "--task-identity"
ROBOTWIN_SCENE_ARG = "--robotwin-scene"


def summarize(out: Path, *, suite=None, task_id=None, resolved_suite=False,
              episode_suite=None, binary_score=False, task_identity=None, robotwin_scene=None) -> dict:
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
    task_name = ep.get("name")
    if not isinstance(task_name, str) or not task_name:
        raise ValueError("the episode has no task identity")
    if ("task" in task or suite is not None) and task.get("task") != task_name:
        raise ValueError("aggregate task name differs from the episode")
    if episode_suite is not None and ep.get("suite") != episode_suite:
        raise ValueError("aggregate suite differs from the planned LIBERO task")
    if robotwin_scene is not None:
        task_identity = robotwin_scene["taskIdentity"]
    if task_identity is not None:
        from task_identity import matches_task

        if not matches_task(ep, task_identity):
            raise ValueError("aggregate scene identity differs from the planned task")
    params = (agg.get("config") or {}).get("params") or {}
    if suite is not None:
        if len(tasks) != 1:
            raise ValueError("expected one LIBERO task in the aggregate")
        recorded_suite = params.get("orbit_task_suite") if resolved_suite else params.get("suite", suite)
        if ep.get("suite") != suite or recorded_suite != suite:
            raise ValueError("aggregate suite differs from the planned LIBERO task")
        native_id = ep.get("task_id")
        if type(native_id) is not int or native_id < 0 or (
                task_id is not None and (native_id != task_id or params.get("orbit_task_id") != task_id)):
            raise ValueError("aggregate task ID differs from the planned LIBERO task")
    error = ep.get("failure_reason")
    if error is not None and not isinstance(error, str):
        raise ValueError("invalid upstream failure reason")
    success = (ep.get("metrics") or {}).get("success", 0 if error else None)
    try:
        finite = type(success) in (bool, int, float) and math.isfinite(success)
    except OverflowError:
        finite = False
    if not finite:
        raise ValueError("the episode success metric must be a finite number")
    if (binary_score or suite is not None) and success not in (0, 1):
        raise ValueError("the episode success metric must be binary")
    steps = ep.get("steps")
    if type(steps) is not int or steps < 0:
        raise ValueError("the episode step count must be a nonnegative integer")
    episode = params.get("orbit_episode")
    if type(episode) is not int or episode < 0:
        raise ValueError("the aggregate must record a nonnegative initial-state ordinal")
    if robotwin_scene is not None:
        if params.get("task_config") != robotwin_scene["taskConfig"]:
            raise ValueError("aggregate RoboTwin scene config differs from the planned task")
        if episode != robotwin_scene["episode"]:
            raise ValueError("aggregate trial number differs from the planned RoboTwin trial")
    return {
        "benchmark": agg.get("benchmark", ""),
        "task": task_name,
        **({"aggregateDigest": "sha256:" + hashlib.sha256(payload).hexdigest()}
           if suite is not None or task_identity is not None else {}),
        **({"taskIdentity": task_identity} if task_identity is not None else {}),
        **({"taskConfig": params["task_config"]} if robotwin_scene is not None else {}),
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
        identity = sys.argv[2:]
        task_identity = None
        robotwin_scene = None
        if identity[:1] == [ROBOTWIN_SCENE_ARG]:
            if len(identity) != 2:
                raise ValueError("usage: check.py OUTPUT --robotwin-scene JSON")
            robotwin_scene = json.loads(identity[1])
            if not isinstance(robotwin_scene, dict):
                raise ValueError("expected a RoboTwin scene object")
            identity = []
        elif identity[:1] == [TASK_IDENTITY_ARG]:
            if len(identity) < 2 or identity[2:] not in ([], [BINARY_SCORE_ARG]):
                raise ValueError("usage: check.py OUTPUT --task-identity JSON [--binary-score]")
            task_identity = json.loads(identity[1])
            if not isinstance(task_identity, dict) or not task_identity:
                raise ValueError("expected a nonempty task identity object")
            identity = identity[2:]
        resolved_suite = identity[:1] == [RESOLVED_SUITE_ARG]
        if resolved_suite:
            identity = identity[1:]
        if len(sys.argv) < 2 or len(identity) > 2 or (resolved_suite and len(identity) != 2):
            raise ValueError("usage: check.py OUTPUT [--structured | --binary-score | SUITE [TASK_ID] | --resolved-suite SUITE TASK_ID]")
        binary_score = identity == [BINARY_SCORE_ARG]
        if binary_score or identity == [STRUCTURED_RECEIPT_ARG]:
            identity = []
        body = summarize(Path(sys.argv[1]), suite=identity[0] if identity else None,
                         task_id=int(identity[1]) if len(identity) == 2 else None,
                         resolved_suite=resolved_suite, binary_score=binary_score,
                         task_identity=task_identity, robotwin_scene=robotwin_scene)
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    dest = Path(os.environ.get("ORBIT_OUTPUT", ".")) / "check.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(body, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
