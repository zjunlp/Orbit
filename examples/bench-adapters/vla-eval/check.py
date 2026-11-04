"""Revalidate the aggregate vla-eval wrote in the solve output (read-only, no network)."""

import json
import os
from pathlib import Path
import sys


def summarize(out: Path) -> dict:
    """The one episode vla-eval exported for this trial, and which initial state it ran."""
    files = sorted(out.glob("*_aggregate.json"))
    if len(files) != 1:
        raise ValueError(f"expected one vla-eval aggregate json, found {len(files)}")
    agg = json.loads(files[0].read_text())
    episodes = [e for t in agg.get("tasks") or [] for e in t.get("episodes", [])]
    if len(episodes) != 1:
        raise ValueError(f"a trial is one episode, the aggregate has {len(episodes)}")
    ep = episodes[0]
    success = (ep.get("metrics") or {}).get("success")
    if success is None:
        raise ValueError("the episode has no success metric")
    params = (agg.get("config") or {}).get("params") or {}
    if "orbit_episode" not in params:
        raise ValueError("the aggregate does not record which initial state ran")
    error = ep.get("failure_reason")
    return {
        "benchmark": agg.get("benchmark", ""),
        "task": ep.get("name", ""),
        "episode": int(params["orbit_episode"]),
        "steps": int(ep.get("steps") or 0),
        "success": float(success),
        "errors": 1 if error else 0,
        "issues": [f"the episode errored upstream ({error}); vla-eval counts it as a failure"]
        if error
        else [],
    }


def main() -> int:
    try:
        body = summarize(Path(sys.argv[1]))
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    dest = Path(os.environ.get("ORBIT_OUTPUT", ".")) / "check.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(body, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
