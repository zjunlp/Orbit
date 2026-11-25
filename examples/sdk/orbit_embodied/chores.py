"""Published CHORES validation samples and the native Stretch task protocol."""

from contextlib import ExitStack
import gzip
import json
import math
from pathlib import Path
import random

from .assets import tree_digest
from .binding import digest, reset_seed

TASKS = ("ObjectNavType", "ObjectNavRoom", "ObjectNavOpenVocab", "ObjectNavRelAttribute",
         "ObjectNavAffordance", "ObjectNavLocalRef", "RoomNav", "PickupType", "FetchType",
         "SimpleExploreHouse")
SUITES = {
    "chores-small": (200, 181, 174, 194, 197, 198, 200, 171, 172, 200),
    "chores-large": (216, 156, 268, 217, 228, 254, 200, 173, 179, 200),
}
ALIASES = {"ObjectNavOpenVocab": "ObjectNavDescription", "SimpleExploreHouse": "RoomVisit"}
ACTIONS = ("m", "r", "l", "b", "end", "sub_done", "ls", "rs", "p", "zm", "zp", "yp",
           "ym", "wp", "wm", "yms", "zms", "zps", "yps", "d")
NAV_CAMERA = "raw_navigation_camera"
ARM_CAMERA = "raw_manipulation_camera"
IN_HAND = "an_object_is_in_hand"
CAMERA_SHAPE = [224, 384, 3]
ROOT = Path("/chores")
FPS = 5


def semantic_profile():
    observations = {
        NAV_CAMERA: {"semantic": "rgb", "dtype": "uint8", "shape": CAMERA_SHAPE,
                     "camera": "stretch-navigation", "layout": "HWC"},
        ARM_CAMERA: {"semantic": "rgb", "dtype": "uint8", "shape": CAMERA_SHAPE,
                     "camera": "stretch-manipulation", "layout": "HWC"},
        IN_HAND: {"semantic": "stretch_holds_object", "dtype": "int64", "shape": [1]},
        "instruction": {"semantic": "language_instruction", "dtype": "string", "shape": []},
        "navigation_pose": {"semantic": "agent_pose", "dtype": "float64", "shape": [4],
                            "frame": "ai2thor-world", "order": ["x_m", "z_m", "yaw_deg", "pitch_deg"]},
    }
    return {"id": "chores-stretch-rgb/1", "observations": observations,
            "action": {"semantic": "stretch_discrete_action_id", "controller": "chores-stretch-20-actions/1",
                       "shape": [1], "order": ["action_id"], "frame": "agent", "unit": "index",
                       "rotation": "30-and-6-deg-base-10-deg-wrist", "gripper": "discrete-pickup-and-dropoff"}}


def read_catalog(root, suite):
    catalog = {}
    for name, expected_count in zip(TASKS, SUITES[suite]):
        with gzip.open(root / suite / (name + ".jsonl.gz"), "rt", encoding="utf-8") as source:
            rows = [json.loads(line) for line in source]
        if len(rows) != expected_count or any(
                row["task_type"] != name or row["expert_length"] <= 0 for row in rows):
            raise ValueError("CHORES published evaluation inventory differs for " + name)
        catalog.update((f"{name}:{index:03d}", row) for index, row in enumerate(rows))
    return catalog


def house_asset_ids(objects):
    for obj in objects:
        yield obj["assetId"]
        yield from house_asset_ids(obj.get("children", ()))


def read_asset_manifest(root):
    manifest = json.loads((root / "manifest.json").read_text())
    if manifest.get("version") != 2:
        raise ValueError("regenerate the CHORES asset bundle with --prepare-assets")
    return manifest


def verify_asset_files(root, catalog, task_ids, manifest):
    houses = {str(catalog[task]["house_index"]) for task in task_ids}
    required = {uid for house in houses for uid in manifest["houses"][house]["assetIds"]}
    for uid in sorted(required):
        asset = root / "assets" / uid
        if asset.is_symlink():
            raise ValueError("CHORES object asset must be a regular directory: " + uid)
        measured = tree_digest(asset) if asset.exists() else None
        if measured != manifest["objectDigests"][uid]:
            raise ValueError("CHORES mounted object asset differs: " + uid)


def start_pose(row, seed):
    x, _, z = row["agent_starting_position"]
    # The pinned Stretch reset calibrates the primary camera before teleporting.
    pitch = 25.0 + 0.2 * random.Random(seed).randrange(20)
    return [x, z, row["agent_y_rotation"], pitch]


def horizon(task_type):
    return 1000 if task_type == "SimpleExploreHouse" else 600


def action_index(action):
    from .driver import EpisodeFailure

    index, = action
    if not math.isfinite(index) or int(index) != index or not 0 <= index < len(ACTIONS):
        raise EpisodeFailure("policy_act", "invalid CHORES Stretch action ID", rejected_actions=[action])
    return int(index)


def goal_evidence(task, row):
    kind = row["task_type"]
    if kind == "SimpleExploreHouse":
        return {"confirmedRooms": list(task.seen_rooms), "roomCount": len(task.house["rooms"])}
    if kind == "RoomNav":
        return {"room": task.get_current_room()}
    if kind in ("FetchType", "PickupType"):
        return {"heldObjects": sorted(task.controller.get_held_objects())}
    targets = row["broad_synset_to_object_ids"][row["synsets"][0]]
    return {"visibleTargets": sorted(oid for oid in targets if task.controller.object_is_visible_in_camera(
        oid, which_camera="nav", maximum_distance=2))}


def native_goal(row, evidence):
    kind = row["task_type"]
    if kind == "SimpleExploreHouse":
        count = evidence["roomCount"]
        if count != row["num_rooms_in_house"]:
            raise ValueError("CHORES room count differs from the registered sample")
        return len(set(evidence["confirmedRooms"])) == count
    if kind == "RoomNav":
        return evidence["room"] in row["room_ids"][row["room_types"][0]]
    targets = set(row["broad_synset_to_object_ids"][row["synsets"][0]])
    if kind in ("FetchType", "PickupType"):
        return bool(targets.intersection(evidence["heldObjects"]))
    visible = set(evidence["visibleTargets"])
    if not visible <= targets:
        raise ValueError("CHORES evidence contains an unexpected target object")
    return bool(visible)


def success_weighted_length(row, success, steps):
    expert_length = row["expert_length"]
    return expert_length / max(steps, expert_length) if success else 0.0


class ChoresBenchmark:
    action_size = 1
    settle_steps = 0

    def __init__(self, reference, task_id):
        self.reference = reference
        env = reference["environment"]
        self.row = env["catalog"][task_id]
        self.horizon = env["horizons"][task_id]
        self.sampler = None
        self.task = None

    def reset(self, sample):
        from ai2thor.platform import CloudRendering
        from environment.stretch_controller import StretchController
        from online_evaluation.max_episode_configs import MAX_EPISODE_LEN_PER_TASK
        from online_evaluation.online_evaluation_types_and_utils import (
            eval_sample_to_normalized_eval_sample, normalized_eval_sample_to_task_spec,
        )
        from tasks.multi_task_eval_sampler import MultiTaskSampler
        from tasks.task_specs import TaskSpecDatasetList
        from utils.constants.stretch_initialization_utils import STRETCH_ENV_ARGS
        from utils.task_datagen_utils import get_core_task_args

        seed = reset_seed(sample, self.reference)
        if sample["initialStateDigest"] != digest(self.row):
            raise ValueError("sample differs from the published CHORES episode")
        kind = ALIASES.get(self.row["task_type"], self.row["task_type"])
        if self.horizon != MAX_EPISODE_LEN_PER_TASK[kind]:
            raise ValueError("CHORES horizon differs from the installed release")
        index = int(sample["taskId"].split(":")[1])
        spec = normalized_eval_sample_to_task_spec(eval_sample_to_normalized_eval_sample(kind, self.row, index))
        house_id = spec["house_index"]
        house_path = ROOT / "houses" / f"{house_id}.json"
        with house_path.open(encoding="utf-8") as source:
            house = json.load(source)
        if digest(house) != self.reference["environment"]["houses"][str(house_id)]:
            raise ValueError("CHORES house differs from the frozen release")
        args = get_core_task_args(max_steps=self.horizon)
        if tuple(args["action_names"]) != ACTIONS:
            raise ValueError("CHORES action order differs from the installed release")
        args["sensors"] = [sensor for sensor in args["sensors"] if sensor.uuid in (NAV_CAMERA, ARM_CAMERA, IN_HAND)]
        # The solve container exposes only the leased GPU to CloudRendering.
        self.sampler = MultiTaskSampler(
            mode="val", task_args=args, houses=[house], house_inds=[house_id],
            controller_args={**STRETCH_ENV_ARGS, "platform": CloudRendering}, controller_type=StretchController,
            task_spec_sampler=TaskSpecDatasetList([spec]), visualize=False, prob_randomize_materials=0,
        )
        self.sampler.set_seed(seed)
        self.task = self.sampler.next_task()
        # Orbit records its own evidence and the native task does not use this logging hook for scoring.
        self.task.record_observations = lambda: None
        self.success = False
        return self.observation(None)

    def observation(self, evidence, native=None):
        pose = self.task.controller.get_current_agent_full_pose()
        if native is None:
            native = self.task.get_observations()
        observation = {**native, "instruction": self.row["natural_language_spec"],
                       "navigation_pose": [pose["position"]["x"], pose["position"]["z"], pose["rotation"]["y"],
                                           pose["cameraHorizon"]], "goalEvidence": evidence}
        if self.row["task_type"] == "SimpleExploreHouse":
            # The upstream task updates previous_room before applying the action.
            observation["roomVisitRoom"] = self.task.previous_room
        return observation

    def state(self, observation):
        keys = ("instruction", "navigation_pose", "goalEvidence")
        if self.row["task_type"] == "SimpleExploreHouse":
            keys += ("roomVisitRoom",)
        return {key: observation[key] for key in keys}

    def step(self, action):
        from .driver import StepResult

        index = action_index(action)
        name = ACTIONS[index]
        result = self.task.step_with_action_str(name)
        done = bool(self.task.is_done())
        evidence = goal_evidence(self.task, self.row) if done and name == "end" else None
        self.success = bool(self.task.is_successful()) if evidence is not None else False
        return StepResult(self.observation(evidence, result.observation), float(result.reward), done, self.success,
                          native_action=[index], native_done=done)

    def result(self):
        steps = self.task.num_steps_taken()
        return {"success": self.success, "successWeightedLength": success_weighted_length(self.row, self.success, steps)}

    def start_video(self, directory):
        import imageio.v2 as imageio

        with ExitStack() as stack:
            self.front = stack.enter_context(imageio.get_writer(str(directory / "video.mp4"), fps=FPS, macro_block_size=2))
            self.arm = stack.enter_context(imageio.get_writer(str(directory / "arm.mp4"), fps=FPS, macro_block_size=2))
            self.video = stack.pop_all()

    def record_frame(self, observation):
        self.front.append_data(observation[NAV_CAMERA])
        self.arm.append_data(observation[ARM_CAMERA])

    def finish_video(self):
        self.video.close()

    def close(self):
        if self.sampler is not None:
            self.sampler.close()


def verify_room_visit(environment, row, initial, controls):
    terminal = controls[-1]["state"]["goalEvidence"]
    confirmation_action = [ACTIONS.index("sub_done")]
    rooms_by_house = environment.get("roomVisitRooms")
    if rooms_by_house is None:
        # Older registrations retained only the terminal room list.
        confirmations = sum(step["nativeAction"] == confirmation_action for step in controls)
        if terminal is not None and len(terminal["confirmedRooms"]) > confirmations:
            raise ValueError("CHORES RoomVisit confirmed more rooms than sub_done actions")
        return

    rooms = set(rooms_by_house[str(row["house_index"])])
    if len(rooms) != row["num_rooms_in_house"] or "roomVisitRoom" not in initial or initial["roomVisitRoom"] is not None:
        raise ValueError("CHORES RoomVisit evidence has an unexpected initial room")
    confirmed = []
    previous_room = None
    for step in controls:
        state = step["state"]
        room = state.get("roomVisitRoom")
        # The upstream room stays latched when the current location has no room ID.
        if ("roomVisitRoom" not in state or (room is None and previous_room is not None)
                or (room is not None and (not isinstance(room, str) or room not in rooms))):
            raise ValueError("CHORES RoomVisit evidence has an invalid room")
        if step["nativeAction"] == confirmation_action and room not in confirmed:
            confirmed.append(room)
        previous_room = room
    if terminal is not None and terminal["confirmedRooms"] != confirmed:
        raise ValueError("CHORES RoomVisit room confirmations differ from sub_done history")


def verify_chores(reference, sample, initial, controls, result):
    environment = reference["environment"]
    row = environment["catalog"][sample["taskId"]]
    seed = reset_seed(sample, reference)
    if sample["initialStateDigest"] != digest(row):
        raise ValueError("CHORES evidence differs from the frozen sample")
    pose = initial["navigation_pose"]
    expected = start_pose(row, seed)
    if (len(pose) != 4 or not all(math.isfinite(x) for x in pose)
            or any(abs(a - b) > 1e-3 for a, b in zip(pose[:2], expected[:2]))
            or any(abs((a - b + 180) % 360 - 180) > 1e-3 for a, b in zip(pose[2:], expected[2:]))):
        raise ValueError("CHORES evidence has a different start pose")
    if initial["instruction"] != row["natural_language_spec"] or initial["goalEvidence"] is not None:
        raise ValueError("CHORES initial evidence has an unexpected instruction or goal reading")
    limit = horizon(row["task_type"])
    previous = pose
    for index, step in enumerate(controls, 1):
        action = action_index(step["action"])
        name = ACTIONS[action]
        stopped = name == "end"
        evidence = step["state"]["goalEvidence"]
        done = stopped or index == limit
        if stopped != (evidence is not None):
            raise ValueError("CHORES terminal goal evidence must accompany an explicit stop")
        success = stopped and native_goal(row, evidence)
        pose = step["state"]["navigation_pose"]
        if (step["nativeAction"] != [action] or step["state"]["instruction"] != initial["instruction"]
                or len(pose) != 4 or not all(math.isfinite(x) for x in pose) or step["reward"] != 0
                or step["nativeSuccess"] is not success
                or step["terminated"] is not done or step["nativeDone"] is not done
                or done != (index == len(controls))):
            raise ValueError("CHORES action, stopping or goal evidence differs from the native rule")
        verify_base_transition(previous, pose, name)
        previous = pose
    if row["task_type"] == "SimpleExploreHouse":
        verify_room_visit(environment, row, initial, controls)
    native = result["native"]
    if (native["success"] is not success
            or native["successWeightedLength"] != success_weighted_length(row, success, len(controls))):
        raise ValueError("CHORES result differs from the verified trace")


def verify_base_transition(previous, pose, action):
    dx, dz, yaw, pitch = (after - before for before, after in zip(previous, pose))
    yaw, pitch = (yaw + 180) % 360 - 180, (pitch + 180) % 360 - 180
    distance = math.hypot(dx, dz)
    tolerance = 1e-3
    # Stretch can stop partway through a motion and drift slightly under physics.
    if action in ("m", "b"):
        plausible = distance <= 0.23 and abs(yaw) <= 2 and abs(pitch) <= tolerance
    elif action in ("r", "l", "rs", "ls"):
        signed_yaw = yaw if action in ("r", "rs") else -yaw
        plausible = (distance <= tolerance and abs(pitch) <= tolerance
                     and -2 <= signed_yaw <= (8 if action in ("rs", "ls") else 32))
    elif action in ("end", "sub_done"):
        plausible = max(distance, abs(yaw), abs(pitch)) <= tolerance
    else:
        # Manipulation does not command the base. Releasing an object also advances physics.
        plausible = distance <= 0.05 and abs(yaw) <= 2 and abs(pitch) <= tolerance
    if not plausible:
        raise ValueError("CHORES base pose transition differs from the recorded action")
