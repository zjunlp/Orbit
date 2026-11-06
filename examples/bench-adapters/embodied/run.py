"""Container entry point; never creates containers or writes Orbit's database."""

import json
from pathlib import Path
import sys

from orbit_embodied import run_episode, verify_episode
from orbit_embodied.evidence import write_json
from orbit_embodied.implementation import archive_implementation, verify_implementation


class LazyOpenPI:
    replan_steps = 5

    def __init__(self, definition):
        self.definition = definition
        self.client = None

    def reset(self, sample):
        from orbit_embodied.openpi import OpenPIClient
        self.client = OpenPIClient("ws://policy:" + str(self.definition["port"]),
                                   timeout=self.definition["callTimeoutSec"])
        if (self.client.metadata.get("calibration") is True) != (self.definition["kind"] == "calibration"):
            raise ValueError("calibration fixtures must be registered explicitly as calibration policies")
        identity = self.client.metadata.get("orbit", {})
        for key in ("checkpointDigest", "normalizationDigest"):
            if identity.get(key) != self.definition[key]:
                raise ValueError("policy server identity mismatch: " + key)
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
        directory, destination, sample_ref, trial_id, verifier_digest = argv[1:]
        measured = archive_implementation(Path(__file__).parent, Path(destination).parent / "implementation")
        if measured != verifier_digest:
            raise ValueError("verifier implementation changed after planning")
        contract = json.loads((Path(directory) / "contract.json").read_text())
        if contract["identity"].get("implementationArchive"):
            verify_implementation(Path(directory).parent / "implementation", contract["identity"]["implementationDigest"])
        result = json.loads((Path(directory) / "native-result.json").read_text())
        if not result["episodeId"].startswith(trial_id + "."):
            raise ValueError("episode attempt belongs to another trial")
        write_json(destination, verify_episode(directory, sample_ref, result["episodeId"]))
        write_json(Path(destination).with_name("verification.json"), {"sampleRef": sample_ref,
                   "episodeId": result["episodeId"], "implementationDigest": verifier_digest})
        return
    from orbit_embodied.libero import LiberoBenchmark
    request = json.loads(Path(argv[1]).read_text())
    measured = archive_implementation(Path(__file__).parent, Path(argv[2]).parent / "implementation")
    if measured != request["implementationDigest"]:
        raise ValueError("driver implementation changed after planning")
    sample = request["sample"]
    suite, name = sample["taskId"].split(":", 1)
    if sample["benchmarkProfile"] != request["reference"]["id"]:
        raise ValueError("sample evaluation profile differs from the frozen reference")
    benchmark = LiberoBenchmark(suite, name)
    policy = LazyOpenPI(request["policy"])
    parameters = request["reference"]["parameters"]
    if (benchmark.horizon != request["reference"]["horizons"][suite]
            or benchmark.settle_steps != parameters["settleSteps"]
            or policy.replan_steps != parameters["replanSteps"]
            or parameters["renderSize"] != 256 or parameters["resizeSize"] != 224):
        raise ValueError("driver settings differ from the frozen reference profile")
    run_episode(benchmark, policy, sample, request["binding"], argv[2], request["episodeId"],
                {"reference": request["reference"], "policy": request["policy"],
                 "implementationDigest": request["implementationDigest"], "implementationArchive": True})


if __name__ == "__main__":
    main(sys.argv[1:])
