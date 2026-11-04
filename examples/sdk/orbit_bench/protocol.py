"""Adapter protocol 1 for Python adapters: the entry point and score replies.

An adapter is four functions taking the request dict and returning the reply dict:

    tasks(req) -> {"tasks": [...], "capabilities": {...}, "metrics": [...], "official": {...}}
    solve(req) / verify(req) -> {"spec": {...}, "issues": [...]}
    score(req) -> valid(...) or invalid(...)

and ends with ``sys.exit(main(tasks, solve, verify, score))``. See docs/guides/bench-adapter.md.
"""

import json
import re
import sys

PROTOCOL = 1
OPS = ("tasks", "solve", "verify", "score")

# The closed set of `failure` kinds (packages/orbit/src/contracts/bench.ts, checked by its tests).
FAILURE_KINDS = (
    "infra",
    "agent_install",
    "env_start",
    "env_step",
    "reset_failed",
    "policy_start",
    "policy_act",
    "server_unreachable",
    "call_watchdog",
    "resume_failed",
    "scorer_error",
    "judge_unavailable",
    "model_unavailable",
    "budget_exceeded",
)

_DIGEST = re.compile(r"(?:^|@)sha256:[a-f0-9]{64}$")


def pinned(image):
    """Whether an image reference is immutable (`name@sha256:...` or a bare image id)."""
    return isinstance(image, str) and bool(_DIGEST.search(image))


def valid(score, max_score=1, *, metrics=None, review=None, episode=None, issues=()):
    """A trusted score (0 is a valid result: the method failed the task)."""
    if not isinstance(score, (int, float)) or score != score:
        raise ValueError("a valid score is a finite number")
    reply = {"score": score, "maxScore": max_score, "invalid": False, "issues": list(issues)}
    if metrics:
        reply["metrics"] = metrics
    if review is not None:
        reply["review"] = review
    if episode is not None:
        reply["episode"] = episode
    return reply


def invalid(failure, *issues, review=None, score=None, max_score=1, episode=None):
    """No trustworthy score: the environment, grader or model failed, not the method."""
    if failure not in FAILURE_KINDS:
        raise ValueError(f"unknown failure kind {failure!r}; use one of {', '.join(FAILURE_KINDS)}")
    reply = {"score": score, "maxScore": max_score, "invalid": True, "failure": failure,
             "issues": list(issues)}
    if review is not None:
        reply["review"] = review
    if episode is not None:
        reply["episode"] = episode
    return reply


def main(tasks, solve, verify, score, argv=None, stdin=None, stdout=None, stderr=None):
    """Answer one request (`adapter.py <op>`, request on stdin); returns the exit code."""
    argv = sys.argv[1:] if argv is None else argv
    stdin, stdout, stderr = stdin or sys.stdin, stdout or sys.stdout, stderr or sys.stderr
    handlers = dict(zip(OPS, (tasks, solve, verify, score)))
    try:
        op = argv[0] if argv else ""
        if op not in handlers:
            raise ValueError(f"unknown operation {op!r}; expected one of {', '.join(OPS)}")
        req = json.load(stdin)
        if req.get("protocol") != PROTOCOL or req.get("op") != op:
            raise ValueError(f"expected adapter protocol {PROTOCOL} and a matching operation")
        reply = handlers[op](req)
        json.dump(reply, stdout, ensure_ascii=False, allow_nan=False)
        stdout.write("\n")
        return 0
    except Exception as exc:  # reported to Orbit as the adapter's error
        print(f"{type(exc).__name__}: {exc}", file=stderr)
        return 1
