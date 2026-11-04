"""Revalidate the aggregate vla-eval wrote in the solve output (read-only, no network)."""

import json
import os
from pathlib import Path
import sys


def summarize(out: Path) -> dict:
    files = sorted(out.glob("*_aggregate.json"))
    if not files:
        raise ValueError("no vla-eval aggregate json in the solve output")
    agg = json.loads(files[-1].read_text())
    episodes = [e for t in agg.get("tasks") or [] for e in t.get("episodes", [])]
    if not episodes:
        raise ValueError("the aggregate has no episodes")
    values = [float(e["metrics"]["success"]) for e in episodes if (e.get("metrics") or {}).get("success") is not None]
    if len(values) != len(episodes):
        raise ValueError("an episode has no success metric")
    errors = sum(1 for e in episodes if e.get("failure_reason"))
    return {"benchmark": agg.get("benchmark", ""), "episodes": len(episodes),
            "success": sum(values) / len(values), "errors": errors,
            "issues": [f"{errors} episode(s) errored upstream (vla-eval counts them as failures)"]
            if errors else []}


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
