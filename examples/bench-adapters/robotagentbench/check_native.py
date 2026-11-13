"""Original CPU receipt integration with explicit synthetic fixtures; never physics."""
import argparse
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import service
import verify


def check(source):
    sys.path.insert(0, str(source / "src"))
    helper = Path(__file__).resolve().parents[2] / "tools/orbit-gui-service/evidence.py"
    module = importlib.util.spec_from_file_location("evidence_helpers", helper)
    evidence = importlib.util.module_from_spec(module)
    module.loader.exec_module(evidence)
    sys.modules["evidence_helpers"] = evidence
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        key = root / "private.pem"
        subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(key)], check=True, capture_output=True)
        public = subprocess.check_output(["openssl", "pkey", "-in", str(key), "-pubout", "-outform", "DER"])
        os.environ["ORBIT_RAB_EVIDENCE_PUBLIC_KEY"] = base64.b64encode(public).decode()
        native = root / "native"
        native.mkdir()
        owner = {"task_name": "prepare_coffee", "episode_id": "synthetic-episode", "status": "finished",
                 "success": False, "scores": {"total": 3, "maximum": 8}}
        native_report = {"status": "completed", "cleanup_errors": [], "source_layers_unchanged": True,
                         "native_shutdown_complete": True, "task_result": owner}
        (native / "native_report.json").write_text(json.dumps(native_report))
        class FixtureBridge:
            completed, abandoned = True, False
            observed = {"episode_id": "synthetic-episode"}
            owner_result = owner
            def close(self):
                return {"closed_ack": True, "transport_exit_code": 0}
        service.ROOT = root / "evidence"
        service.ROOT.mkdir()
        (service.ROOT / "synthetic-trace.txt").write_text("Explicit fixture; not robot execution.")
        original = evidence.sign_result
        evidence.sign_result = lambda output, unused: original(output, key)
        plan = {"nativeTask": "prepare_coffee", "nativeOutput": str(native)}
        service.RobotService(FixtureBridge(), plan).finalize()
        checked = verify.verify(service.ROOT)
        assert checked["score"] == 3 / 8 and checked["success"] is False
        result_path = service.ROOT / "result.json"
        result = json.loads(result_path.read_text())
        for change in ("incomplete", "abandoned", "wrong-task", "missing-ack"):
            modified = copy.deepcopy(result)
            if change == "incomplete":
                modified["completed"] = False
            elif change == "abandoned":
                modified["abandoned"] = True
            elif change == "wrong-task":
                modified["plan"]["nativeTask"] = "another-task"
            else:
                modified["closure"]["closed_ack"] = False
            result_path.write_text(json.dumps(modified))
            original(service.ROOT, key)
            try:
                verify.verify(service.ROOT)
            except ValueError:
                pass
            else:
                raise AssertionError("Accepted invalid fixture: " + change)
        result_path.write_text(json.dumps(result))
        original(service.ROOT, key)
        (service.ROOT / "synthetic-trace.txt").write_text("tampered")
        try:
            verify.verify(service.ROOT)
        except ValueError:
            pass
        else:
            raise AssertionError("Accepted tampered evidence")
    print("passed: original CPU receipts, signed evidence, native completion and tampering checks; physics not run")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    check(parser.parse_args().source.resolve(strict=True))
