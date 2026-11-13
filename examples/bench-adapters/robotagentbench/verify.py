"""CPU verification of original owner receipts and service-signed evidence."""
import hashlib
import json
import math
import os
from pathlib import Path
import sys


def native_score(owner):
    if (not isinstance(owner, dict) or owner.get("status") != "finished"
            or type(owner.get("success")) is not bool or owner.get("evaluation_valid") is False
            or owner.get("termination_reason") == "client_closed"):
        raise ValueError("Native episode is incomplete, abandoned or invalid")
    scores = owner["scores"]
    total, maximum = scores["total"], scores["maximum"]
    if (type(total) not in (int, float) or type(maximum) not in (int, float)
            or not math.isfinite(total) or not math.isfinite(maximum)
            or maximum <= 0 or not 0 <= total <= maximum):
        raise ValueError("Original terminal score has no trustworthy native denominator")
    return total / maximum, owner["success"]


def verify(root):
    from evidence_helpers import verify_signature
    from robotagentbench.model_examples.native_receipts import verify as verify_receipts
    verify_signature(root, os.environ["ORBIT_RAB_EVIDENCE_PUBLIC_KEY"])
    result = json.loads((root / "result.json").read_text())
    files = {p.relative_to(root).as_posix(): p for p in root.rglob("*") if p.is_file()
             and p.relative_to(root).as_posix() not in ("result.json", "evidence-signature.json")}
    if any(p.is_symlink() for p in root.rglob("*")) or set(files) != set(result["sha256"]):
        raise ValueError("Evidence file set has changed")
    for name, path in files.items():
        value = hashlib.sha256(path.read_bytes()).hexdigest()
        if value != result["sha256"][name]:
            raise ValueError("Signed native evidence changed")
    if result.get("version") != 1 or not result.get("valid"):
        raise ValueError(result.get("error", "Native cleanup was not confirmed"))
    if result.get("completed") is not True or result.get("abandoned") is not False:
        raise ValueError("Native episode never terminated or was abandoned")
    plan, closure = result["plan"], result["closure"]
    if not verify_receipts("room", plan["nativeTask"], result["episode"], result["receipts"],
                          closed_ack=closure["closed_ack"], worker_exit_code=closure["transport_exit_code"]):
        raise ValueError("Native task owner did not confirm clean closure")
    native = result["receipts"]["files"]["native_report.json"]["task_result"]
    if native != result["ownerResult"]:
        raise ValueError("Close acknowledgement and independent owner receipt disagree")
    score, success = native_score(native)
    return {"valid": True, "score": score, "success": success, "plan": plan}


def main():
    output = Path(os.environ["ORBIT_OUTPUT"])
    output.mkdir(parents=True, exist_ok=True)
    try:
        result = verify(Path(sys.argv[1]))
    except Exception as exc:
        result = {"valid": False, "error": type(exc).__name__ + ": " + str(exc)}
    (output / "result.json").write_text(json.dumps(result, allow_nan=False, indent=2))
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
