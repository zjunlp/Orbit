"""Container entry point; never creates containers or writes Orbit's database."""

import json
import os
from pathlib import Path
import sys

from orbit_embodied import digest, run_episode, verify_episode
from orbit_embodied.evidence import write_json
from orbit_embodied.implementation import archive_implementation, verify_implementation


class LazyPolicy:
    def __init__(self, definition):
        self.definition = definition
        self.client = None
        self.replan_steps = definition.get("replanSteps", 5)

    def reset(self, sample):
        if self.definition["connector"] == "openpi-ws":
            from orbit_embodied.openpi import OpenPIClient
            self.client = OpenPIClient("ws://policy:" + str(self.definition["port"]),
                                      timeout=self.definition["callTimeoutSec"], replan_steps=self.replan_steps)
        elif self.definition["connector"] == "groot-zmq":
            from orbit_embodied.groot import GrootClient
            self.client = GrootClient("tcp://policy:" + str(self.definition["port"]), self.definition["profile"],
                                     timeout=self.definition["callTimeoutSec"], replan_steps=self.replan_steps,
                                     io_adapter=self.definition["ioAdapter"])
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
        self.client.reset(sample)

    def act(self, observation):
        return self.client.act(observation)

    def close(self):
        if self.client is not None:
            self.client.close()


def main(argv):
    if argv[0] == "verify":
        directory, destination, expected_path = argv[1:]
        expected = json.loads(Path(expected_path).read_text())
        sample_ref = expected["sample"]["sampleId"]
        verifier_digest = expected["verifierDigest"]
        measured = archive_implementation(Path(__file__).parent, Path(destination).parent / "implementation")
        if measured != verifier_digest:
            raise ValueError("verifier implementation changed after planning")
        contract = json.loads((Path(directory) / "contract.json").read_text())
        if contract["identity"].get("implementationArchive"):
            verify_implementation(Path(directory).parent / "implementation", contract["identity"]["implementationDigest"])
        result = json.loads((Path(directory) / "native-result.json").read_text())
        write_json(destination, verify_episode(directory, sample_ref, result["episodeId"], expected))
        write_json(Path(destination).with_name("verification.json"), {"sampleRef": sample_ref,
                   "episodeId": result["episodeId"], "implementationDigest": verifier_digest,
                   "solveRunId": expected["solveRunId"], "trialId": expected["trialId"],
                   "expectationDigest": digest(expected)})
        return
    request = json.loads(Path(argv[1]).read_text())
    measured = archive_implementation(Path(__file__).parent, Path(argv[2]).parent / "implementation")
    if measured != request["implementationDigest"]:
        raise ValueError("driver implementation changed after planning")
    sample = request["sample"]
    if sample["benchmarkProfile"] != request["reference"]["id"]:
        raise ValueError("sample evaluation profile differs from the frozen reference")
    if request["reference"].get("environment", {}).get("kind") == "registered-gym":
        from orbit_embodied.gym import GymBenchmark
        benchmark = GymBenchmark(request["reference"], sample["taskId"])
        expected_horizon = request["reference"]["environment"]["horizon"]
    else:
        from orbit_embodied.libero import LiberoBenchmark
        suite, name = sample["taskId"].split(":", 1)
        benchmark = LiberoBenchmark(suite, name)
        expected_horizon = request["reference"]["horizons"][suite]
    policy = LazyPolicy(request["policy"])
    parameters = request["reference"]["parameters"]
    if (benchmark.horizon != expected_horizon or benchmark.settle_steps != parameters["settleSteps"]
            or policy.replan_steps != parameters["replanSteps"]
            or parameters["renderSize"] != 256
            or (request["policy"]["connector"] == "openpi-ws" and parameters["resizeSize"] != 224)):
        raise ValueError("driver settings differ from the frozen reference profile")
    run_episode(benchmark, policy, sample, request["binding"], argv[2], request["episodeId"],
                {"reference": request["reference"], "policy": request["policy"],
                 "execution": {"runId": os.environ["ORBIT_RUN_ID"], "trialId": request["trialId"]},
                 "implementationDigest": request["implementationDigest"], "implementationArchive": True})


if __name__ == "__main__":
    main(sys.argv[1:])
