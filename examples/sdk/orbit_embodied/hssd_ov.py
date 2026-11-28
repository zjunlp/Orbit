"""HSSD-OV catalog, native Habitat controls and geodesic replay scoring."""

import gzip
import json
import math
from pathlib import Path

from .binding import digest, file_digest, reset_seed

ROOT = Path("/hssd-ov")
EPISODES = Path("eval/hssdov")
VIEWPOINTS = Path("protocol/instance_viewpoints/hssd/val")
VOCABULARY = Path("vocab/objectnav_goal_sets.json")
CONFIG = "/opt/stopwatch/configs/eval_hssdov.yaml"
ACTIONS = ("stop", "move_forward", "turn_left", "turn_right")
SHAPE = [360, 640, 3]
FPS = 5
HORIZON = 500
THRESHOLD = 0.25
FORWARD_STEP = 0.25
TURN_ANGLE = 30


def semantic_profile():
    return {"id": "hssd-ov-stretch-discrete/1",
            "observations": {
                "rgb": {"semantic": "rgb", "dtype": "uint8", "shape": SHAPE, "layout": "HWC",
                        "camera": "habitat-stretch-forward-120deg"},
                "instruction": {"semantic": "language_instruction", "dtype": "string", "shape": []},
                "agent_position": {"semantic": "agent_position", "dtype": "float64", "shape": [3],
                                   "unit": "m", "frame": "habitat-world", "order": ["x_m", "y_m", "z_m"]}},
            "action": {"semantic": "discrete_navigation_action_id", "shape": [1], "order": ["action_id"],
                       "controller": "habitat-stretch-25cm-30deg-stop/1", "frame": "agent", "unit": "index",
                       "rotation": "30-deg-yaw", "gripper": "none"}}


def scene_name(value):
    name = Path(value).name
    suffix = ".scene_instance.json"
    return name[:-len(suffix)] if name.endswith(suffix) else name


def episode_id(scene, index):
    return f"{scene_name(scene)}:{index}"


def goal_instruction(category):
    return "Find the " + category.replace("_", " ") + "."


def read_catalog(root):
    rows = {}
    directory = root / EPISODES / "content"
    definitions = json.loads((root / VOCABULARY).read_text())["scoring_class_ids"]["hssdov"]
    for path in sorted(directory.glob("*.json.gz")):
        scene = path.name.split(".")[0]
        scene_protocol = json.loads((root / VIEWPOINTS / (scene + ".json")).read_text())
        instances = scene_protocol["instances"]
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            episodes = json.load(stream)["episodes"]
        goals = {}
        for row in episodes:
            if scene_name(row["scene_id"]) != scene:
                raise ValueError("HSSD-OV content references another scene")
            category = row["object_category"]
            if category not in goals:
                accepted = set(definitions[category])
                goals[category] = [view["agent_state"]["position"] for obj in instances
                                   if obj["class_id"] in accepted for view in obj["view_points"]]
                if not goals[category]:
                    raise ValueError("HSSD-OV episode has no published scoring viewpoint")
            name = episode_id(row["scene_id"], row["episode_id"])
            if name in rows:
                raise ValueError("duplicate HSSD-OV episode " + name)
            rows[name] = {"scene": row["scene_id"], "id": str(row["episode_id"]), "category": category,
                          "start": row["start_position"], "rotation": row["start_rotation"],
                          "viewpointsDigest": digest(goals[category]),
                          "navmeshDigest": "sha256:" + scene_protocol["navmesh_sha256"]}
    if len(rows) != 1751 or len({row["scene"] for row in rows.values()}) != 43:
        raise ValueError("expected the complete published HSSD-OV evaluation population")
    return rows


def load_episode_dataset(config, row, task_id):
    """Parse the published shard for this scene and materialize only the requested episode."""
    from habitat.datasets.object_nav.object_nav_dataset import ObjectNavDatasetV1
    from stopwatch.eval.env import _dataset_config

    scene = scene_name(row["scene"])
    with gzip.open(ROOT / EPISODES / "content" / (scene + ".json.gz"), "rt", encoding="utf-8") as stream:
        native = json.load(stream)
    selected, = (ep for ep in native["episodes"] if episode_id(ep["scene_id"], ep["episode_id"]) == task_id)
    native["episodes"] = [selected]
    scenes_dir = _dataset_config(config).scenes_dir
    dataset = ObjectNavDatasetV1()
    dataset.from_json(json.dumps(native), scenes_dir=scenes_dir)
    episode, = dataset.episodes
    episode.episode_id = str(selected["episode_id"])
    scene_config = config.dataset.scene_dataset_config
    episode.scene_dataset_config = str(Path(scenes_dir) / scene_config) if scene_config is not None else "default"
    return dataset, episode


def action_index(action):
    from .driver import EpisodeFailure

    value, = action
    if not math.isfinite(value) or int(value) != value or not 0 <= value < len(ACTIONS):
        raise EpisodeFailure("policy_act", "invalid HSSD-OV discrete action", rejected_actions=[action])
    return int(value)


def distance_to_target(pathfinder, position, targets):
    from types import SimpleNamespace
    from stopwatch.eval.geometry import geodesic_distance

    value = geodesic_distance(SimpleNamespace(pathfinder=pathfinder), position, targets)
    return value if math.isfinite(value) else None


def score_navigation(start, distance, length, stopped):
    success = stopped and distance is not None and distance < THRESHOLD
    spl = start / max(start, length) if success and start is not None and start > 0 else float(success and length == 0)
    return {"success": success, "distanceToTarget": distance, "spl": spl, "pathLength": length}


class HssdOvBenchmark:
    action_size = 1
    settle_steps = 0
    horizon = HORIZON

    def __init__(self, reference, task_id):
        self.reference = reference
        self.row = reference["environment"]["catalog"][task_id]
        self.env = None
        self.directory = None

    def start_video(self, directory):
        import imageio.v2 as imageio

        self.video = imageio.get_writer(str(directory / "video.mp4"), fps=FPS, macro_block_size=2)

    def record_frame(self, observation):
        self.video.append_data(observation["rgb"])

    def finish_video(self):
        self.video.close()

    def set_evidence_directory(self, directory):
        self.directory = directory

    def reset(self, sample):
        import habitat
        import numpy as np
        from stopwatch.config import load_config
        from stopwatch.eval.env import _habitat_config, _install_navmesh
        from stopwatch.eval.geometry import _load_goal_sets, destination_targets, load_scene_instances

        reset_seed(sample, self.reference)
        if sample["initialStateDigest"] != digest(self.row):
            raise ValueError("HSSD-OV sample differs from the frozen catalog")
        config = load_config(CONFIG, [f"paths.root={ROOT}"])
        dataset, episode = load_episode_dataset(config, self.row, sample["taskId"])
        scene = self.row["scene"]
        if (episode.start_position != self.row["start"] or episode.start_rotation != self.row["rotation"]
                or episode.object_category != self.row["category"]):
            raise ValueError("installed HSSD-OV episode differs from the frozen catalog")
        # Docker exposes only the leased GPU. Let EGL select it directly;
        # its NVIDIA device index can differ from container-local CUDA index 0.
        self.env = habitat.Env(config=_habitat_config(config, -1), dataset=dataset)
        self.env.seed(config.seed)
        _install_navmesh(self.env.sim, config)
        self.env.current_episode = episode
        raw = self.env.reset()
        member_ids = _load_goal_sets(ROOT)["scoring_class_ids"]["hssdov"][episode.object_category]
        instances = load_scene_instances(ROOT / VIEWPOINTS.parent, "val", scene)
        viewpoints = [view["agent_state"]["position"] for obj in instances if obj["class_id"] in member_ids
                      for view in obj["view_points"]]
        if digest(viewpoints) != self.row["viewpointsDigest"]:
            raise ValueError("HSSD-OV installed goal viewpoints differ from the frozen catalog")
        self.targets = destination_targets(instances, member_ids)
        if self.directory is None:
            raise ValueError("missing episode evidence directory")
        from .evidence import write_json
        write_json(self.directory / "goal-viewpoints.json", viewpoints)
        # PathFinder serializes the protocol navmesh for CPU-only geodesic scoring.
        path = self.directory / "navigation.navmesh"
        if not self.env.sim.pathfinder.save_nav_mesh(str(path)):
            raise ValueError("native HSSD-OV navmesh did not serialize")
        if file_digest(path) != self.row["navmeshDigest"]:
            raise ValueError("rebuilt HSSD-OV navmesh differs from the published scoring geometry")
        observation = self.observation(raw)
        self.previous = observation["agent_position"]
        self.start = distance_to_target(self.env.sim.pathfinder, self.previous, self.targets)
        self.distance = self.start
        self.path_length = 0.0
        self.stopped = False
        self.steps = 0
        if not np.isfinite(self.previous).all() or self.start is None:
            raise ValueError("HSSD-OV start has no finite path to an accepted viewpoint")
        return observation

    def observation(self, raw):
        import quaternion

        pose = self.env.sim.get_agent_state()
        rotation = quaternion.as_float_array(pose.rotation)
        return {"rgb": raw["rgb"], "instruction": goal_instruction(self.row["category"]),
                "agent_position": pose.position.tolist(), "rotation": rotation[[1, 2, 3, 0]].tolist()}

    def state(self, observation):
        state = {key: observation[key] for key in ("instruction", "agent_position", "rotation")}
        return {**state, "truncated": not self.stopped and self.steps == HORIZON}

    def step(self, action):
        from .driver import StepResult

        index = action_index(action)
        observation = self.observation(self.env.step(ACTIONS[index]))
        position = observation["agent_position"]
        self.path_length += math.dist(self.previous, position)
        self.previous = position
        self.steps += 1
        self.stopped = index == 0
        done = self.stopped or self.steps == HORIZON
        if bool(self.env.episode_over) != done:
            raise ValueError("Habitat termination differs from the published HSSD-OV protocol")
        if done:
            self.distance = distance_to_target(self.env.sim.pathfinder, position, self.targets)
        success = self.stopped and self.distance is not None and self.distance < THRESHOLD
        return StepResult(observation, 0.0, done, success, native_action=[index], native_done=done)

    def result(self):
        return score_navigation(self.start, self.distance, self.path_length, self.stopped)

    def close(self):
        if self.env is not None:
            self.env.close()


def unit_rotation(value):
    import numpy as np

    rotation = np.asarray(value)
    if rotation.shape != (4,) or rotation.dtype.kind not in "iuf" or not np.isfinite(rotation).all():
        raise ValueError("invalid HSSD-OV native rotation")
    norm = np.linalg.norm(rotation)
    if abs(norm - 1) > 1e-4:
        raise ValueError("invalid HSSD-OV native rotation")
    return rotation / norm


def same_rotation(actual, expected):
    import numpy as np

    return (np.allclose(actual, expected, rtol=0, atol=1e-4)
            or np.allclose(-actual, expected, rtol=0, atol=1e-4))


def replay_pose(pathfinder, position, rotation, action):
    import numpy as np

    if action == 1:
        # Habitat moves along local -Z, then filters the translation with sliding enabled.
        start = np.asarray(position, dtype=np.float32)
        forward = np.array([0.0, 0.0, -FORWARD_STEP])
        offset = 2 * np.cross(rotation[:3], forward)
        target = start + forward + rotation[3] * offset + np.cross(rotation[:3], offset)
        position = pathfinder.try_step(start, target.astype(np.float32))
    elif action in (2, 3):
        # Compose the current xyzw orientation with the local Y-axis turn.
        half_angle = math.radians(TURN_ANGLE) / 2
        sine = math.sin(half_angle) if action == 2 else -math.sin(half_angle)
        cosine = math.cos(half_angle)
        x, y, z, w = rotation
        rotation = np.array([cosine * x - sine * z, cosine * y + sine * w,
                             cosine * z + sine * x, cosine * w - sine * y])
    return position, rotation


def verify_hssd(reference, sample, initial, controls, result, directory):
    import habitat_sim
    import numpy as np

    row = reference["environment"]["catalog"][sample["taskId"]]
    reset_seed(sample, reference)
    if sample["initialStateDigest"] != digest(row):
        raise ValueError("HSSD-OV evidence differs from the frozen sample")
    rotation = unit_rotation(initial["rotation"])
    if (not same_rotation(rotation, row["rotation"])
            or not np.allclose(initial["agent_position"], row["start"], rtol=0, atol=1e-4)
            or initial["instruction"] != goal_instruction(row["category"])):
        raise ValueError("HSSD-OV evidence contains an unexpected start or instruction")
    viewpoints = json.loads((directory / "goal-viewpoints.json").read_text())
    if digest(viewpoints) != row["viewpointsDigest"]:
        raise ValueError("HSSD-OV goal viewpoints differ from the frozen catalog")
    targets = np.asarray(viewpoints, dtype=np.float32)
    pathfinder = habitat_sim.PathFinder()
    navmesh = directory / "navigation.navmesh"
    if file_digest(navmesh) != row["navmeshDigest"]:
        raise ValueError("HSSD-OV navmesh differs from the frozen scoring geometry")
    if not pathfinder.load_nav_mesh(str(navmesh)):
        raise ValueError("HSSD-OV evidence navmesh failed to load")
    position = initial["agent_position"]
    start = distance_to_target(pathfinder, position, targets)
    distance, length, stopped = None, 0.0, False
    for index, step in enumerate(controls, 1):
        action = action_index(step["action"])
        state = step["state"]
        next_position = state["agent_position"]
        if len(next_position) != 3 or not all(math.isfinite(x) for x in next_position):
            raise ValueError("invalid HSSD-OV native position")
        next_rotation = unit_rotation(state["rotation"])
        expected_position, expected_rotation = replay_pose(pathfinder, position, rotation, action)
        tolerance = 1e-4 if action == 1 else 1e-5
        if not (math.dist(next_position, expected_position) <= tolerance
                and same_rotation(next_rotation, expected_rotation)):
            raise ValueError("HSSD-OV motion contradicts the native action")
        length += math.dist(position, next_position)
        position, rotation = next_position, next_rotation
        stopped = action == 0
        done = stopped or index == HORIZON
        if done:
            distance = distance_to_target(pathfinder, position, targets)
        success = stopped and distance is not None and distance < THRESHOLD
        if (step["nativeAction"] != [action] or step["reward"] != 0 or step["nativeSuccess"] is not success
                or step["nativeDone"] is not done or step["terminated"] is not done or done != (index == len(controls))
                or state["instruction"] != initial["instruction"]):
            raise ValueError("HSSD-OV action, stopping or goal evidence contradicts the native protocol")
    if start is None or result["native"] != score_navigation(start, distance, length, stopped):
        raise ValueError("HSSD-OV result differs from independent geodesic scoring")
