"""Container entry point; never creates containers or writes Orbit's database."""

import json
import os
from pathlib import Path
import sys
import time

from orbit_embodied import digest, run_episode, verify_episode
from orbit_embodied.binding import reference_horizon
from orbit_embodied.evidence import write_json
from orbit_embodied.implementation import archive_implementation, verify_implementation


class LazyPolicy:
    def __init__(self, definition):
        self.definition = definition
        self.client = None
        self.replan_steps = definition.get("replanSteps", 5)

    def reset(self, sample):
        if self.definition["connector"] == "openpi-ws":
            from orbit_embodied.openpi import OpenPIClient, prepare_libero_observation, prepare_robocasa_observation
            prepare = (prepare_robocasa_observation if self.definition.get("ioAdapter") == "robocasa-native"
                       else prepare_libero_observation)
            self.client = OpenPIClient("ws://policy:" + str(self.definition["port"]),
                                      timeout=self.definition["callTimeoutSec"], replan_steps=self.replan_steps,
                                      prepare=prepare)
        elif self.definition["connector"] == "groot-zmq":
            from orbit_embodied.groot import GrootClient
            self.client = GrootClient("tcp://policy:" + str(self.definition["port"]), self.definition["profile"],
                                     timeout=self.definition["callTimeoutSec"], replan_steps=self.replan_steps,
                                     io_adapter=self.definition["ioAdapter"])
        elif self.definition["connector"] == "openvla-ws":
            from orbit_embodied.openvla import OpenVLAClient
            self.client = OpenVLAClient("ws://policy:" + str(self.definition["port"]),
                                       timeout=self.definition["callTimeoutSec"], replan_steps=self.replan_steps)
        else:
            raise ValueError("unsupported policy connector")
        if (self.client.metadata.get("calibration") is True) != (self.definition["kind"] == "calibration"):
            raise ValueError("calibration fixtures must be registered explicitly as calibration policies")
        identity = self.client.metadata.get("orbit", {})
        for key in ("checkpointDigest", "normalizationDigest"):
            if identity.get(key) != self.definition[key]:
                raise ValueError("policy server identity mismatch: " + key)
        if self.definition.get("backboneDigest") != identity.get("backboneDigest"):
            raise ValueError("policy backbone identity differs from the frozen definition")
        if identity.get("randomness") != self.definition["randomness"]:
            raise ValueError("policy random-stream declaration does not match this reference")
        if (self.definition.get("normalizationKey") is not None
                and self.client.metadata.get("unnormKey") != self.definition["normalizationKey"]):
            raise ValueError("policy normalization key differs from the frozen definition")
        self.client.reset(sample)

    def act(self, observation):
        return self.client.act(observation)

    def close(self):
        if self.client is not None:
            self.client.close()


def main(argv):
    if argv[0] == "verify":
        started = time.monotonic()
        directory, destination, expected_path = argv[1:]
        expected = json.loads(Path(expected_path).read_text())
        sample_ref = expected["sample"]["sampleId"]
        verifier_digest = expected["verifierDigest"]
        measured = archive_implementation(Path(__file__).parent, Path(destination).parent / "implementation")
        if measured != verifier_digest:
            raise ValueError("verifier implementation changed after planning")
        contract = json.loads((Path(directory) / "contract.json").read_text())
        if contract["identity"].get("implementationArchive"):
            root = Path(directory).parents[1] if expected.get("batch") else Path(directory).parent
            verify_implementation(root / "implementation", contract["identity"]["implementationDigest"])
        if expected.get("batch"):
            plan = json.loads((Path(directory).parents[1] / "batch-plan.json").read_text())
            if plan != expected["batch"]["plan"]:
                raise ValueError("saved batch plan differs from frozen membership")
        result = json.loads((Path(directory) / "native-result.json").read_text())
        reading_seconds = time.monotonic() - started
        write_json(destination, verify_episode(directory, sample_ref, result["episodeId"], expected))
        write_json(Path(destination).with_name("verification.json"), {"sampleRef": sample_ref,
                   "episodeId": result["episodeId"], "implementationDigest": verifier_digest,
                   "solveRunId": expected["solveRunId"], "trialId": expected["trialId"],
                   "expectationDigest": digest(expected),
                   "timing": {"readAndArchiveSeconds": reading_seconds,
                              "verifySeconds": time.monotonic() - started - reading_seconds,
                              "totalSeconds": time.monotonic() - started}})
        return
    request = json.loads(Path(argv[1]).read_text())
    root = Path(argv[2]) if argv[0] == "batch" else Path(argv[2]).parent
    measured = archive_implementation(Path(__file__).parent, root / "implementation")
    if argv[0] == "batch":
        from orbit_embodied.batch import run_batch
        if any(item["implementationDigest"] != measured for item in request["episodes"]):
            raise ValueError("batch implementation changed after planning")
        run_batch(request["plan"], request["episodes"], root, execute_episode)
        return
    if measured != request["implementationDigest"]:
        raise ValueError("driver implementation changed after planning")
    execute_episode(request, argv[2])


def execute_episode(request, destination, cancelled=None):
    sample = request["sample"]
    reference = request["reference"]
    if sample["benchmarkProfile"] != reference["id"]:
        raise ValueError("sample evaluation profile differs from the frozen reference")
    kind = reference.get("environment", {}).get("kind")
    if kind == "registered-gym":
        from orbit_embodied.gym import GymBenchmark
        benchmark = GymBenchmark(reference, sample["taskId"])
    elif kind == "robocasa365":
        from orbit_embodied.robocasa import RoboCasaBenchmark
        benchmark = RoboCasaBenchmark(reference, sample["taskId"])
    else:
        from orbit_embodied.libero import LiberoBenchmark
        suite, name = sample["taskId"].split(":", 1)
        benchmark = LiberoBenchmark(suite, name)
    expected_horizon = reference_horizon(reference, sample["taskId"])
    policy = LazyPolicy(request["policy"])
    parameters = request["reference"]["parameters"]
    if (benchmark.horizon != expected_horizon or benchmark.settle_steps != parameters["settleSteps"]
            or policy.replan_steps != parameters["replanSteps"]
            or parameters["renderSize"] != 256
            or (request["policy"]["connector"] == "openpi-ws" and parameters["resizeSize"] != 224)):
        raise ValueError("driver settings differ from the frozen reference profile")
    return run_episode(benchmark, policy, sample, request["binding"], destination, request["episodeId"],
                {"reference": request["reference"], "policy": request["policy"],
                 "execution": {"runId": os.environ["ORBIT_RUN_ID"], "trialId": request["trialId"]},
                 "implementationDigest": request["implementationDigest"], "implementationArchive": True,
                 **({"batch": request["batch"]} if request.get("batch") else {})},
                cancelled=cancelled,
                deadline=time.monotonic() + 60 * request.get("timeoutMin", 20) if cancelled is not None else None,
                seal_before_media=cancelled is not None)


if __name__ == "__main__":
    main(sys.argv[1:])
