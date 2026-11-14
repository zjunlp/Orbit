"""Instrument the pinned official loop; compare native execution with the Orbit SDK."""

import argparse
import copy
import hashlib
import importlib.util
import inspect
import json
import logging
from pathlib import Path
import shutil
import sys

import numpy as np

from orbit_embodied import digest, run_episode, verify_episode
from orbit_embodied.evidence import file_digest, write_json
from orbit_embodied.libero import LiberoBenchmark
from orbit_embodied.implementation import archive_implementation
from orbit_embodied.openpi import prepare_libero_observation, quaternion_to_axis_angle


def equal(actual, expected, label):
    if isinstance(actual, dict) and isinstance(expected, dict):
        if set(actual) != set(expected):
            raise ValueError(label + ": fields differ")
        for key in actual:
            equal(actual[key], expected[key], label + "/" + key)
    elif isinstance(actual, np.ndarray) or isinstance(expected, np.ndarray):
        left, right = np.asarray(actual), np.asarray(expected)
        if left.dtype != right.dtype or left.shape != right.shape or not np.array_equal(left, right):
            raise ValueError(label + ": array dtype, shape or values differ")
    elif actual != expected:
        raise ValueError(label + ": values differ")


def array_fingerprint(value):
    array = np.ascontiguousarray(value)
    return {"dtype": str(array.dtype), "shape": list(array.shape),
            "sha256": hashlib.sha256(array.tobytes()).hexdigest()}


def raw_observation(raw, instruction):
    return {"front_rgb": raw["agentview_image"], "wrist_rgb": raw["robot0_eye_in_hand_image"],
            "eef_position": raw["robot0_eef_pos"], "eef_quaternion": raw["robot0_eef_quat"],
            "gripper_position": raw["robot0_gripper_qpos"], "instruction": instruction}


def native_observation(canonical):
    return {"agentview_image": canonical["front_rgb"], "robot0_eye_in_hand_image": canonical["wrist_rgb"],
            "robot0_eef_pos": canonical["eef_position"], "robot0_eef_quat": canonical["eef_quaternion"],
            "robot0_gripper_qpos": canonical["gripper_position"]}


def observation_fingerprint(raw):
    return {name: array_fingerprint(raw[name]) for name in (
        "agentview_image", "robot0_eye_in_hand_image", "robot0_eef_pos", "robot0_eef_quat", "robot0_gripper_qpos")}


class TraceEnvironment:
    def __init__(self, env):
        self.inner = env
        self.rows = []
        self.initial = None
        self.raw = None

    def __getattr__(self, name):
        return getattr(self.inner, name)

    def capture(self, raw):
        return {"physics": array_fingerprint(self.inner.get_sim_state()),
                "simulationTime": float(self.inner.env.sim.data.time),
                "observations": observation_fingerprint(raw)}

    def reset(self):
        self.raw = self.inner.reset()
        return self.raw

    def set_init_state(self, state):
        self.raw = self.inner.set_init_state(state)
        self.initial = self.capture(self.raw)
        return self.raw

    def step(self, action):
        result = self.inner.step(action)
        self.raw, reward, done, _ = result
        self.rows.append({"action": np.asarray(action).tolist(), "reward": float(reward),
                          "done": bool(done), **self.capture(self.raw)})
        return result


class FirstEpisodeComplete(BaseException):
    pass


def episode_counters(values):
    names = ("task_id", "episode_idx", "task_episodes", "task_successes", "total_episodes", "total_successes", "done")
    return {name: values[name].item() if isinstance(values[name], np.generic) else values[name] for name in names}


def load_reference(path):
    spec = importlib.util.spec_from_file_location("orbit_pinned_reference", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def official_episode(native, plan, destination, real_policy):
    destination.mkdir(parents=True)
    traces, requests, chunks, clients, counters, errors = [], [], [], [], {}, []
    original_env = native._get_libero_env
    original_client = native._websocket_client_policy.WebsocketClientPolicy
    original_video = native.imageio.mimwrite

    def environment(task, resolution, seed):
        equal(task.name, plan["sample"]["taskId"].split(":", 1)[1], "official first task")
        env, instruction = original_env(task, resolution, seed)
        wrapped = TraceEnvironment(env)
        traces.append(wrapped)
        return wrapped, instruction

    class RecordingClient:
        def __init__(self, host, port):
            self.client = original_client(host, port) if real_policy else None
            clients.append(self)
            if self.client:
                metadata = self.client.get_server_metadata()
                identity = metadata["orbit"]
                for name in ("checkpointDigest", "normalizationDigest", "randomness"):
                    equal(identity[name], plan["policy"][name], "policy identity/" + name)
                if plan.get("pairedRuntime"):
                    equal(metadata["comparison"]["branch"], "reference", "reference random stream")

        def infer(self, packet):
            canonical = prepare_libero_observation(raw_observation(traces[-1].raw, packet["prompt"]))
            equal(packet, canonical, "official versus SDK preprocessing")
            requests.append({key: value.copy() if isinstance(value, np.ndarray) else value
                             for key, value in packet.items()})
            response = self.client.infer(packet) if self.client else {"actions": np.zeros((50, 7), np.float32)}
            actions = np.asarray(response["actions"])
            chunks.append(actions.copy())
            np.save(destination / ("chunk-" + str(len(chunks) - 1) + ".npy"), actions, allow_pickle=False)
            np.savez_compressed(destination / ("request-" + str(len(requests) - 1) + ".npz"),
                                **{key: value for key, value in packet.items() if isinstance(value, np.ndarray)})
            return response

    def completed_video(*args, **kwargs):
        frame = inspect.currentframe().f_back
        counters.update(episode_counters(frame.f_locals))
        original_video(*args, **kwargs)
        raise FirstEpisodeComplete()

    class ErrorCapture(logging.Handler):
        def emit(self, record):
            if record.levelno >= logging.ERROR:
                errors.append(record.getMessage())

    handler = ErrorCapture()
    logging.getLogger().addHandler(handler)
    native._get_libero_env = environment
    native._websocket_client_policy.WebsocketClientPolicy = RecordingClient
    native.imageio.mimwrite = completed_video
    try:
        args = native.Args(host="policy", port=plan["policy"]["port"],
                           task_suite_name=plan["suite"], num_trials_per_task=1,
                           seed=plan["sample"]["environmentSeed"], video_out_path=str(destination / "video"))
        try:
            native.eval_libero(args)
        except FirstEpisodeComplete:
            pass
        if not counters or errors:
            raise ValueError("official episode did not complete without error: " + repr(errors))
        equal({key: counters[key] for key in ("task_id", "episode_idx", "task_episodes", "total_episodes")},
              {"task_id": 0, "episode_idx": 0, "task_episodes": 1, "total_episodes": 1}, "official prefix")
        equal(int(counters["done"]), counters["total_successes"], "official score")
        write_json(destination / "counters.json", counters)
        write_json(destination / "trace.json", {"initial": traces[0].initial, "steps": traces[0].rows})
        return traces[0], requests, chunks, counters
    finally:
        native._get_libero_env = original_env
        native._websocket_client_policy.WebsocketClientPolicy = original_client
        native.imageio.mimwrite = original_video
        logging.getLogger().removeHandler(handler)
        for client in clients:
            if client.client:
                client.client._ws.close()
        for trace in traces:
            trace.close()


def sdk_replay(plan, destination, chunks, requests=None):
    import libero.libero.envs as envs
    original_env = envs.OffScreenRenderEnv
    traces = []

    def environment(**kwargs):
        wrapped = TraceEnvironment(original_env(**kwargs))
        traces.append(wrapped)
        return wrapped

    class ReplayPolicy:
        replan_steps = 5

        def __init__(self):
            self.calls = 0

        def reset(self, sample):
            pass

        def act(self, observation):
            if requests is not None:
                equal(prepare_libero_observation(observation), requests[self.calls], "replayed policy request")
            chunk = chunks[self.calls]
            self.calls += 1
            return chunk

        def close(self):
            pass

    envs.OffScreenRenderEnv = environment
    try:
        suite, task = plan["sample"]["taskId"].split(":", 1)
        benchmark, policy = LiberoBenchmark(suite, task), ReplayPolicy()
        result = run_episode(benchmark, policy, plan["sample"], plan["binding"], destination,
                             "parity-replay", {"fixture": "recorded actions; no model inference"})
        verify_episode(destination, plan["sample"]["sampleId"], "parity-replay")
        if not result["valid"]:
            raise ValueError("SDK replay failed: " + repr(result))
        equal(policy.calls, len(chunks), "number of model requests")
        write_json(destination.parent / "replay-trace.json", {"initial": traces[0].initial, "steps": traces[0].rows})
        return traces[0], result
    finally:
        envs.OffScreenRenderEnv = original_env


def fixed_actions(native, plan, destination):
    checks = []
    for state_id in plan["fixedInitialStates"]:
        sample = {**plan["sample"], "initialStateId": state_id}
        np.random.seed(sample["environmentSeed"])
        suite = native.benchmark.get_benchmark_dict()[plan["suite"]]()
        task = suite.get_task(0)
        env, _ = native._get_libero_env(task, native.LIBERO_ENV_RESOLUTION, sample["environmentSeed"])
        official = TraceEnvironment(env)
        sdk = LiberoBenchmark(plan["suite"], task.name)
        try:
            official.reset()
            official.set_init_state(suite.get_task_init_states(0)[int(state_id)])
            for _ in range(native.Args().num_steps_wait):
                official.step(native.LIBERO_DUMMY_ACTION)
            canonical = sdk.reset(sample)
            equal(official.capture(official.raw), TraceEnvironment(sdk.env).capture(native_observation(canonical)),
                  "fixed reset initial state " + state_id)
            for index in range(plan["fixedActionSteps"]):
                action = np.array([0.03 * np.sin(index / 3.), 0.02 * np.cos(index / 4.),
                                   0.01 * ((index % 3) - 1), 0., 0., 0.01 * np.sin(index),
                                   -1. if index < plan["fixedActionSteps"] // 2 else 1.])
                left = official.step(action.tolist())
                right = sdk.step(action)
                equal(bool(left[2]), right.terminated, "fixed termination")
                equal(float(left[1]), right.reward, "fixed reward")
                equal(official.capture(left[0]), TraceEnvironment(sdk.env).capture(native_observation(right.observation)),
                      "fixed control state " + state_id + "/" + str(index))
            checks.append({"initialState": state_id, "steps": plan["fixedActionSteps"], "result": "passed"})
        finally:
            official.close()
            sdk.close()
    write_json(destination / "fixed-actions.json", checks)
    return checks


def sdk_live(plan, source, destination):
    import libero.libero.envs as envs
    import orbit_embodied.openpi as connector
    spec = importlib.util.spec_from_file_location("orbit_production_driver", source / "run.py")
    driver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(driver)
    definition = copy.deepcopy(plan["policyDefinition"])
    definition["port"] += 1
    traces, requests, chunks = [], [], []
    original_env, original_prepare, original_act = envs.OffScreenRenderEnv, connector.prepare_libero_observation, connector.OpenPIClient.act

    def environment(**kwargs):
        wrapped = TraceEnvironment(original_env(**kwargs))
        traces.append(wrapped)
        return wrapped

    def prepare(observation):
        packet = original_prepare(observation)
        requests.append({key: value.copy() if isinstance(value, np.ndarray) else value for key, value in packet.items()})
        return packet

    def act(client, observation):
        equal(client.metadata["comparison"]["branch"], "candidate", "candidate random stream")
        result = original_act(client, observation)
        chunks.append(np.asarray(result).copy())
        return result

    envs.OffScreenRenderEnv = environment
    connector.prepare_libero_observation = prepare
    connector.OpenPIClient.act = act
    try:
        measured = archive_implementation(source, destination.parent / "implementation-candidate")
        equal(measured, plan["orbitImplementationDigest"], "production driver fingerprint")
        suite, task = plan["sample"]["taskId"].split(":", 1)
        result = run_episode(LiberoBenchmark(suite, task), driver.LazyPolicy(definition), plan["sample"],
                             plan["binding"], destination, "parity-live-candidate",
                             {"reference": plan["reference"], "policy": definition,
                              "implementationDigest": measured, "comparison": "shared compiled model; independent stream"})
        verify_episode(destination, plan["sample"]["sampleId"], "parity-live-candidate")
        if not result["valid"]:
            raise ValueError("live SDK candidate failed: " + repr(result))
        write_json(destination.parent / "candidate-trace.json", {"initial": traces[0].initial, "steps": traces[0].rows})
        return traces[0], requests, chunks, result
    finally:
        envs.OffScreenRenderEnv = original_env
        connector.prepare_libero_observation = original_prepare
        connector.OpenPIClient.act = original_act


def quaternion_cases(native):
    cases = [[0., 0., 0., 1.01], [0., 0., 0., -1.01], [0., 0., 1., 0.],
             [0., 0., 0., 1.], [0., 0., 0., -1.]]
    rng = np.random.RandomState(31)
    values = rng.normal(size=(100, 4))
    values /= np.linalg.norm(values, axis=1, keepdims=True)
    for quaternion in cases + values.tolist():
        value = np.asarray(quaternion)
        equal(quaternion_to_axis_angle(value), native._quat2axisangle(value.copy()), "reference quaternion conversion")
    return len(cases) + len(values)


def compare_saved_orbit(plan, directory, chunks, counters):
    result = json.loads((directory / "native-result.json").read_text())
    verify_episode(directory, plan["sample"]["sampleId"], result["episodeId"])
    equal(file_digest(directory / "evidence-manifest.json"), plan["orbitEvidenceDigest"], "original solve evidence")
    contract = json.loads((directory / "contract.json").read_text())
    equal(contract["sample"], plan["sample"], "original solve sample")
    equal(contract["bindingDigest"], plan["binding"]["digest"], "original solve binding")
    equal(contract["identity"]["implementationDigest"], plan["orbitImplementationDigest"], "original solve implementation")
    for key in ("checkpointDigest", "normalizationDigest", "randomness"):
        equal(contract["identity"]["policy"][key], plan["policy"][key], "original policy/" + key)
    stored = sorted((directory / "chunks").glob("*.npy"), key=lambda p: int(p.stem))
    equal(len(stored), len(chunks), "real model inference count")
    for index, path in enumerate(stored):
        equal(np.load(path, allow_pickle=False), chunks[index], "real model action chunk " + str(index))
    equal(result["valid"], True, "original verdict validity")
    equal(int(result["success"]), counters["total_successes"], "original native success")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("deterministic", "rollout"))
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("/orbit/output"))
    args = parser.parse_args()
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    plan = json.loads(args.plan.read_text())
    expected_digest = plan.pop("digest")
    equal(digest(plan), expected_digest, "comparison plan digest")
    source = args.plan.parent
    for relative, expected in plan["files"].items():
        equal(file_digest(source / relative), expected, "audited source/" + relative)
    shutil.copytree(source, output / "implementation", ignore=shutil.ignore_patterns("__pycache__"))
    native = load_reference(source / "reference_main.py")
    report = {"version": 1, "mode": args.mode, "planDigest": expected_digest,
              "scope": "sampled first-episode parity; not full-suite statistical equivalence", "result": "failed"}
    if plan.get("pairedRuntime") and args.mode == "rollout":
        report["scope"] = "sampled protocol parity with shared compiled model and independent streams; no cross-process bitwise claim"
    if plan.get("parentPlanDigest"):
        report["parentPlanDigest"] = plan["parentPlanDigest"]
    try:
        report["quaternionCases"] = quaternion_cases(native)
        if args.mode == "deterministic":
            report["fixedActions"] = fixed_actions(native, plan, output)
        official, requests, chunks, counters = official_episode(native, plan, output / "official", args.mode == "rollout")
        if args.mode == "rollout" and plan.get("pairedRuntime"):
            replay, live_requests, live_chunks, verdict = sdk_live(plan, source, output / "candidate")
            equal(len(live_requests), len(requests), "live inference count")
            for index, (packet, actions) in enumerate(zip(live_requests, live_chunks)):
                equal(packet, requests[index], "live request " + str(index))
                equal(actions, chunks[index], "live predicted action chunk " + str(index))
        else:
            replay, verdict = sdk_replay(plan, output / "replay", chunks, requests)
        equal(replay.initial, official.initial, "initial native physics and cameras")
        equal(replay.rows, official.rows, "native action/physics/observation trace")
        equal(int(verdict["success"]), counters["total_successes"], "native success and official numerator")
        equal(verdict["steps"], len(official.rows) - plan["settleSteps"], "native control steps")
        if args.mode == "deterministic":
            equal(verdict["success"], False, "zero fixture success")
            equal(verdict["steps"], plan["horizon"], "official horizon")
        elif not plan.get("pairedRuntime"):
            original = compare_saved_orbit(plan, Path("/orbit-solve/episode"), chunks, counters)
            equal(original["steps"], verdict["steps"], "real rollout length")
            actual = [json.loads(line) for line in (Path("/orbit-solve/episode") / "actions.jsonl").read_text().splitlines()]
            reconstructed = [json.loads(line) for line in (output / "replay/actions.jsonl").read_text().splitlines()]
            comparable = lambda rows: [{key: value for key, value in row.items() if key != "wallSeconds"} for row in rows]
            equal(comparable(actual), comparable(reconstructed), "original executed actions and recorded states")
        report.update(result="passed", controlSteps=verdict["steps"], modelRequests=len(chunks),
                      officialNumerator=counters["total_successes"], officialDenominator=counters["total_episodes"],
                      exactPreprocessingRequests=len(requests), exactPhysicsSteps=len(replay.rows),
                      inputs="captured from both live clients" if plan.get("pairedRuntime") and args.mode == "rollout"
                             else "captured from official client; SDK inputs verified during deterministic replay",
                      modelRuntime="explicit zero fixture" if args.mode == "deterministic" else
                                   "shared compiled model; independent initial key-0 streams" if plan.get("pairedRuntime")
                                   else "independently compiled model processes")
    except Exception as exc:
        report["error"] = str(exc)
        raise
    finally:
        write_json(output / "parity-result.json", report)


if __name__ == "__main__":
    main()
