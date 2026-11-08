"""Pinned SimplerEnv paper scene grids with the native GR00T robot I/O wrappers."""

from itertools import islice, product
from math import prod


def grid_size(scene):
    ranges = [scene["robotX"], scene["robotY"], *(scene["rpy"][i:i + 3] for i in (0, 3, 6))]
    if "objectEpisodes" in scene:
        start, stop = scene["objectEpisodes"]
        object_count = int(stop - start)
    else:
        object_count = int(scene["objectX"][2]) * int(scene["objectY"][2])
    return object_count * prod(int(bounds[2]) for bounds in ranges)


def initial_state_count(environment, task):
    scenes = environment.get("simplerScenes")
    return sum(grid_size(scene) for scene in scenes[task]) if scenes else None


def scene_at(environment, task, index):
    if index >= 0:
        for scene in environment["simplerScenes"][task]:
            count = grid_size(scene)
            if index < count:
                return scene, index
            index -= count
    raise ValueError("initial-state index exceeds the frozen SimplerEnv scene grid")


def reset_options(scene, index):
    from numpy import array, linspace
    from sapien.core import Pose
    from transforms3d.euler import euler2quat

    def points(bounds):
        return linspace(bounds[0], bounds[1], int(bounds[2]))

    robot_poses = product(points(scene["robotX"]), points(scene["robotY"]),
                          *(points(scene["rpy"][i:i + 3]) for i in (0, 3, 6)))
    if "objectEpisodes" in scene:
        object_poses = ({"episode_id": episode} for episode in range(*map(int, scene["objectEpisodes"])))
    else:
        object_poses = ({"init_xy": array([x, y])}
                        for x, y in product(points(scene["objectX"]), points(scene["objectY"])))
    (x, y, roll, pitch, yaw), object_pose = next(islice(product(robot_poses, object_poses), index, index + 1))
    quaternion = (Pose(q=euler2quat(roll, pitch, yaw)) * Pose(q=scene["quat"])).q
    return {"robot_init_options": {"init_xy": array([x, y]), "init_rot_quat": quaternion},
            "obj_init_options": object_pose}


def rt_options(environment, ray_tracing):
    if ray_tracing and environment.get("rtDenoiser") is False:
        return {"render_config": {"rt_use_denoiser": False}}
    return {}


def make_wrapper(environment, task, index):
    from gr00t.eval.sim.SimplerEnv.simpler_env import GoogleFractalEnv, WidowXBridgeEnv

    google = environment["simplerRobot"] == "google"
    wrapper_type = GoogleFractalEnv if google else WidowXBridgeEnv
    image_size = (256, 320) if google else (256, 256)
    if "simplerScenes" not in environment:
        name = task.split("/", 1)[1]
        ray_tracing = name.endswith("_drawer")
        options = rt_options(environment, ray_tracing)
        if not options:
            return wrapper_type(name, image_size), None, ray_tracing
        import gymnasium
        from simpler_env import ENVIRONMENT_MAP

        env_name, defaults = ENVIRONMENT_MAP[name]
        kwargs = {**defaults, "obs_mode": "rgbd", "prepackaged_config": True, **options}
        native = gymnasium.make(env_name, **kwargs)
        native._max_episode_steps = 10000
        reset = None
    else:
        from mani_skill2_real2sim import ASSET_DIR
        from simpler_env.utils.env.env_builder import build_maniskill2_env, get_robot_control_mode

        scene, index = scene_at(environment, task, index)
        reset = reset_options(scene, index)
        overlay = str(ASSET_DIR / scene["overlay"]) if "overlay" in scene else None
        build = scene.get("build", {})
        ray_tracing = build.get("shader_dir") == "rt"
        native = build_maniskill2_env(
            scene["env"], obs_mode="rgbd", robot=scene["robot"], sim_freq=scene["simHz"],
            control_mode=get_robot_control_mode(scene["robot"], None), control_freq=scene["controlHz"],
            max_episode_steps=scene["horizon"], scene_name=scene["scene"],
            camera_cfgs={"add_segmentation": True}, rgb_overlay_path=overlay, **build,
            **rt_options(environment, ray_tracing),
        )
    # The pinned constructors always build a prepackaged environment. Their observation
    # and control methods only need these fields when a native env is supplied.
    wrapper = wrapper_type.__new__(wrapper_type)
    wrapper.env, wrapper.image_size = native, image_size
    if google:
        wrapper.sticky_gripper_num_repeat = 15
    else:
        from numpy import array
        wrapper.default_rot = array([[0, 0, 1.0], [0, 1.0, 0], [-1.0, 0, 0]])
    return wrapper, reset, ray_tracing


def check_rt_camera(wrapper, camera):
    import numpy as np

    # Read the latest raw camera texture so a Visual Matching overlay cannot hide
    # a failed ray-traced render from the benchmark.
    color = wrapper.env.unwrapped._cameras[camera].get_images()["Color"][..., :3]
    if not np.isfinite(color).all() or not np.ptp(color, axis=(0, 1)).any():
        raise RuntimeError("native ray-traced camera returned a constant or non-finite image")


def reset_wrapper(wrapper, seed, options):
    if options is None:
        observation, _ = wrapper.reset(seed=seed)
        return observation
    # The pinned wrapper reset drops native options. Preserve the same gripper reset and
    # observation processing around the native reset with the exact scene-grid coordinates.
    if hasattr(wrapper, "sticky_gripper_num_repeat"):
        wrapper.previous_gripper_action = None
        wrapper.sticky_action_is_on = False
        wrapper.sticky_gripper_action = 0.0
        wrapper.gripper_action_repeat = 0
    raw, _ = wrapper.env.reset(seed=seed, options=options)
    return wrapper._process_observation(raw)
