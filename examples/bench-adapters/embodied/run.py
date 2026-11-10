"""Container entry point; never creates containers or writes Orbit's database."""

from functools import lru_cache, partial
import json
import os
from pathlib import Path
import sys
import time

from orbit_embodied import digest, run_episode, verify_episode
from orbit_embodied.assets import COLOSSEUM_ASSET_ROOT, tree_digest
from orbit_embodied.binding import reference_horizon
from orbit_embodied.evidence import write_json
from orbit_embodied.implementation import archive_implementation, verify_implementation
from orbit_embodied.libero_plus import NATIVE_ROOT as LIBERO_PLUS_ROOT
from orbit_embodied.libero_suites import HORIZONS
from orbit_embodied.vlabench import ASSETS_ROOT as VLABENCH_ASSETS


SIMULATOR_ASSET_ROOTS = {"libero-plus": LIBERO_PLUS_ROOT + "/assets", "vlabench": VLABENCH_ASSETS,
                        "molmospaces": "/molmospaces", "colosseum-v2": COLOSSEUM_ASSET_ROOT}


class LazyPolicy:
    def __init__(self, definition):
        self.definition = definition
        self.client = None
        self.replan_steps = definition.get("replanSteps", 5)

    def reset(self, sample):
        if self.definition["connector"] == "openpi-ws":
            from orbit_embodied.openpi import (OpenPIClient, prepare_libero_observation,
                                               prepare_robocasa_observation, prepare_robotwin_observation)
            prepare = {"robocasa-native": prepare_robocasa_observation,
                       "robotwin-native": prepare_robotwin_observation}.get(
                           self.definition.get("ioAdapter"), prepare_libero_observation)
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
        elif self.definition["connector"] == "policy-ws":
            from orbit_embodied.policy_ws import PolicyClient
            self.client = PolicyClient("ws://policy:" + str(self.definition["port"]),
                                       timeout=self.definition["callTimeoutSec"], replan_steps=self.replan_steps,
                                       action_size=self.definition["profile"]["action"]["shape"][0])
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

    @property
    def conversion(self):
        return getattr(self.client, "conversion", None)

    def act(self, observation):
        return self.client.act(observation)

    def close(self):
        if self.client is not None:
            self.client.close()


def verify_simulator_assets(requests):
    expected = {}
    for request in requests:
        environment = request["reference"].get("environment", {})
        root = SIMULATOR_ASSET_ROOTS.get(environment.get("kind"))
        if root is None:
            continue
        assets = environment.get("assets") or {}
        if assets.get("target") != root or not assets.get("digest"):
            raise ValueError("missing frozen simulator asset identity for " + root)
        if expected.setdefault(root, assets["digest"]) != assets["digest"]:
            raise ValueError("conflicting simulator asset digests in solve batch")
    for root, checksum in expected.items():
        if tree_digest(root) != checksum:
            raise ValueError("mounted simulator asset digest mismatch: " + root)


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
        # Every evidence version >= 2 was written with an archive; it cannot opt out of the check.
        if expected["evidenceVersion"] >= 2 and not contract["identity"].get("implementationArchive"):
            raise ValueError("solve evidence lacks its implementation archive")
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
        environment = expected["reference"].get("environment", {})
        stopping = {}
        if environment.get("protocol") == "diffusion-policy":
            stopping["diffusionStoppingVerified"] = result["valid"] and expected["evidenceVersion"] == 4
        write_json(Path(destination).with_name("verification.json"), {"sampleRef": sample_ref,
                   "episodeId": result["episodeId"], "implementationDigest": verifier_digest,
                   "solveRunId": expected["solveRunId"], "trialId": expected["trialId"],
                   "expectationDigest": digest(expected), **stopping,
                   "timing": {"readAndArchiveSeconds": reading_seconds,
                              "verifySeconds": time.monotonic() - started - reading_seconds,
                              "totalSeconds": time.monotonic() - started}})
        kind = expected["reference"].get("environment", {}).get("kind")
        if kind is None and expected["sample"]["taskId"].partition(":")[0] in HORIZONS:
            kind = "libero"
        if kind == "libero-plus":
            kind = "libero"
        if result["valid"] and kind in ("robotwin", "libero"):
            from orbit_embodied.episode_trajectory import write_trajectory
            try:
                write_trajectory(directory, Path(destination).with_name("orbit-trajectory.json"), result, expected,
                                 kind=kind)
            except (OSError, ValueError, KeyError, TypeError) as exc:
                print("Native trajectory unavailable: " + str(exc), file=sys.stderr)
        return
    request = json.loads(Path(argv[1]).read_text())
    root = Path(argv[2]) if argv[0] == "batch" else Path(argv[2]).parent
    measured = archive_implementation(Path(__file__).parent, root / "implementation")
    if argv[0] == "batch":
        from orbit_embodied.batch import run_batch
        if any(item["implementationDigest"] != measured for item in request["episodes"]):
            raise ValueError("batch implementation changed after planning")
        @lru_cache(maxsize=1)
        def prepare():
            verify_simulator_assets(request["episodes"])

        run_batch(request["plan"], request["episodes"], root, partial(execute_episode, prepare=prepare))
        return
    if measured != request["implementationDigest"]:
        raise ValueError("driver implementation changed after planning")
    execute_episode(request, argv[2], prepare=lambda: verify_simulator_assets([request]))


def execute_episode(request, destination, cancelled=None, *, prepare=None):
    sample = request["sample"]
    reference = request["reference"]
    if sample["benchmarkProfile"] != reference["id"]:
        raise ValueError("sample evaluation profile differs from the frozen reference")
    kind = reference.get("environment", {}).get("kind")
    if kind == "registered-gym":
        from orbit_embodied.gym import GymBenchmark, SimplerPolicyTerminationBenchmark
        native = SimplerPolicyTerminationBenchmark if reference["environment"].get("policyTermination") else GymBenchmark
        benchmark = native(reference, sample["taskId"])
    elif kind == "robocasa365":
        from orbit_embodied.robocasa import RoboCasaBenchmark, RoboCasaDiffusionBenchmark
        native = RoboCasaDiffusionBenchmark if reference["environment"].get("protocol") == "diffusion-policy" else RoboCasaBenchmark
        benchmark = native(reference, sample["taskId"])
    elif kind == "robocasa-v02":
        from orbit_embodied.robocasa_v02 import RoboCasaV02Benchmark
        benchmark = RoboCasaV02Benchmark(reference, sample["taskId"])
    elif kind == "robomimic":
        from orbit_embodied.robomimic import RoboMimicBenchmark
        benchmark = RoboMimicBenchmark(reference, sample["taskId"])
    elif kind == "vima-bench":
        from orbit_embodied.vima_bench import VIMABenchBenchmark
        benchmark = VIMABenchBenchmark(reference, sample["taskId"])
    elif kind == "molmospaces":
        from orbit_embodied.molmospaces import MolmoSpacesBenchmark
        benchmark = MolmoSpacesBenchmark(reference, sample["taskId"])
    elif kind == "colosseum-v2":
        from orbit_embodied.colosseum import ColosseumBenchmark
        benchmark = ColosseumBenchmark(reference, sample["taskId"])
    elif kind == "rlbench":
        from orbit_embodied.rlbench import RLBenchBenchmark
        benchmark = RLBenchBenchmark(reference, sample["taskId"])
    elif kind == "robotwin":
        from orbit_embodied.robotwin import RoboTwinBenchmark, RoboTwinCartesianBenchmark
        native = RoboTwinCartesianBenchmark if reference["environment"].get("controller") == "ee" else RoboTwinBenchmark
        benchmark = native(reference, sample["taskId"])
    elif kind in ("maniskill3", "metaworld"):
        from orbit_embodied.tabletop import ManiSkillBenchmark, MetaWorldBenchmark
        native = ManiSkillBenchmark if kind == "maniskill3" else MetaWorldBenchmark
        benchmark = native(reference, sample["taskId"])
    elif kind == "maniskill3-tabletop":
        from orbit_embodied.tabletop import ManiSkillTabletopBenchmark
        benchmark = ManiSkillTabletopBenchmark(reference, sample["taskId"])
    elif kind == "robolab":
        from orbit_embodied.robolab import RoboLabBenchmark
        benchmark = RoboLabBenchmark(reference, sample["taskId"])
    elif kind == "robodojo":
        from orbit_embodied.robodojo import RoboDojoBenchmark
        benchmark = RoboDojoBenchmark(reference, sample["taskId"])
    elif kind == "calvin":
        from orbit_embodied.calvin import CalvinBenchmark
        benchmark = CalvinBenchmark(reference, sample["taskId"])
    elif kind == "vlabench":
        from orbit_embodied.vlabench import VLABenchBenchmark
        benchmark = VLABenchBenchmark(reference, sample["taskId"])
    else:
        from orbit_embodied.libero import LiberoBenchmark, LiberoPlusBenchmark
        suite, name = sample["taskId"].split(":", 1)
        native = LiberoPlusBenchmark if kind == "libero-plus" else LiberoBenchmark
        benchmark = native(suite, name, settle_steps=reference["parameters"]["settleSteps"])
    expected_horizon = reference_horizon(reference, sample["taskId"])
    expected_render_size = {"vlabench": 480, "robocasa-v02": 128, "rlbench": 128}.get(kind, 256)
    policy = LazyPolicy(request["policy"])
    parameters = request["reference"]["parameters"]
    if (benchmark.horizon != expected_horizon or benchmark.settle_steps != parameters["settleSteps"]
            or policy.replan_steps != parameters["replanSteps"]
            or (kind not in ("robotwin", "maniskill3", "maniskill3-tabletop", "metaworld", "calvin", "robolab", "robodojo",
                            "robomimic", "vima-bench", "molmospaces", "colosseum-v2")
                and parameters["renderSize"] != expected_render_size)
            or (request["policy"]["connector"] == "openpi-ws" and parameters["resizeSize"] != 224)):
        raise ValueError("driver settings differ from the frozen reference profile")
    return run_episode(benchmark, policy, sample, request["binding"], destination, request["episodeId"],
                {"reference": request["reference"], "policy": request["policy"],
                 "execution": {"runId": os.environ["ORBIT_RUN_ID"], "trialId": request["trialId"]},
                 "implementationDigest": request["implementationDigest"], "implementationArchive": True,
                 **({"batch": request["batch"]} if request.get("batch") else {})},
                prepare=prepare, cancelled=cancelled,
                deadline=time.monotonic() + 60 * request.get("timeoutMin", 20) if cancelled is not None else None,
                seal_before_media=cancelled is not None)


if __name__ == "__main__":
    main(sys.argv[1:])
