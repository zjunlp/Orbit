"""Native adapter planning with synthetic registrations; no containers are executed."""

import importlib.util
import copy
import gzip
import io
import json
from itertools import product
from pathlib import Path
import shutil
import tarfile
import tempfile
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "examples/sdk"))

from orbit_embodied import digest, resolve_binding  # noqa: E402
from orbit_embodied.assets import tree_digest  # noqa: E402
from orbit_embodied.binding import (  # noqa: E402
    check_distinct_resets,
    reference_horizon,
    reset_seed,
    seed_asset,
)
from orbit_embodied.evidence import write_json  # noqa: E402
from orbit_embodied.implementation import archive_implementation, verify_implementation  # noqa: E402


ADAPTER = Path(__file__).resolve().parent / "adapter.py"
SPEC = importlib.util.spec_from_file_location("native_embodied_adapter", ADAPTER)
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


class AdapterPlanningTests(unittest.TestCase):
    def test_libero_planner_expands_the_count_in_each_initial_state_asset(self):
        import pickle
        from zipfile import ZipFile

        import numpy as np

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            suite = "libero_spatial"
            source = root / "third_party/libero/libero/libero"
            (source / "benchmark").mkdir(parents=True)
            (source / "benchmark/libero_suite_task_map.py").write_text(
                "libero_task_map = {'libero_spatial': ['first', 'second']}\n")
            states = source / "init_files" / suite
            states.mkdir(parents=True)
            for name, count in (("first", 2), ("second", 3)):
                with ZipFile(states / (name + ".pruned_init"), "w") as asset:
                    asset.writestr("archive/data.pkl", pickle.dumps(np.zeros((count, 79)), protocol=2))
            tasks = adapter.catalog(root, suite)
            self.assertEqual([task["tags"]["initialStateCount"] for task in tasks], ["2", "3"])
            command = [sys.executable, "-S", "-B", str(ADAPTER.with_name("plan.py")),
                       "--reference-source", str(root), "--all-tasks"]
            plan = json.loads(subprocess.check_output([*command, "--all-initial-states"], text=True))
            expected = [(task["id"], str(index), task["tags"]["initialStateDigest"])
                        for task in tasks for index in range(int(task["tags"]["initialStateCount"]))]
            self.assertEqual([(row["taskId"], row["initialStateId"], row["initialStateDigest"])
                              for row in plan["items"]], expected)
            explicit = subprocess.run([*command, "--initial-state", "2"], capture_output=True, text=True)
            self.assertNotEqual(explicit.returncode, 0)
            self.assertIn("initial-state index exceeds the selected reset recipe", explicit.stderr)

    def test_hssd_configurator_help_works_without_site_packages(self):
        path = ADAPTER.parent / "benchmarks/hssd-ov/configure_hssd_ov.py"
        output = subprocess.check_output([sys.executable, "-B", "-E", "-S", str(path), "--help"], text=True)
        self.assertIn("--prepare-assets", output)

    def test_hssd_preparation_and_registration_reject_unpublished_shader_changes(self):
        path = ADAPTER.parent / "benchmarks/hssd-ov/configure_hssd_ov.py"
        spec = importlib.util.spec_from_file_location("configure_hssd_fixture", path)
        config = importlib.util.module_from_spec(spec)
        with patch.object(sys, "path", sys.path.copy()):
            spec.loader.exec_module(config)
        with tempfile.TemporaryDirectory() as temporary:
            assets = Path(temporary)
            scenes = assets / "scenes/hssd-hab"
            template = {"render_asset": "cube.glb"}
            original_config = scenes / "hssd-hab.scene_dataset_config.json"
            template_path = scenes / "objects/cube.object_config.json"
            write_json(template_path, template)
            write_json(original_config, {"scene_instances": {"paths": {".json": ["scenes"]}}})
            write_json(scenes / "stages/room.stage_config.json", {"render_asset": "room.glb"})
            write_json(scenes / "scenes/room.scene_instance.json", {
                "stage_instance": {"template_name": "stages/room"},
                "object_instances": [{"template_name": "cube", "motion_type": "STATIC"}],
            })
            for name in ("objects/cube.glb", "stages/room.glb"):
                (scenes / name).write_bytes(b"fixture geometry")
            source_config = assets / "configs/eval_hssdov.yaml"
            source_config.parent.mkdir()
            source_config.write_text("# fixture\n")
            catalog = {"room:0": {"scene": "room.scene_instance.json", "category": "cube"}}
            published, generated = config.scene_bundle(assets, catalog)
            release = {"sceneManifestDigest": digest(published), "evaluation": {}}
            self.assertEqual(published["files"][original_config.relative_to(assets).as_posix()],
                             adapter.file_digest(original_config))
            manifest_path = assets / "orbit-hssd-ov-scenes.json"

            write_json(template_path, {**template, "shader_type": "flat"})
            with self.assertRaisesRegex(ValueError, "scene bundle differs from the pinned release"):
                config.prepare_scenes(assets, catalog, release)
            self.assertFalse(manifest_path.exists())
            self.assertFalse((scenes / "derived_scenes").exists())

            write_json(template_path, template)
            config.prepare_scenes(assets, catalog, release)
            for output, expected in generated.items():
                self.assertEqual(output.read_bytes(), expected)
            reference = config.reference(assets, assets, catalog, release)
            self.assertEqual(reference["environment"]["assets"]["digest"], release["sceneManifestDigest"])

            write_json(template_path, {**template, "shader_type": "flat"})
            local, _ = config.scene_bundle(assets, catalog)
            self.assertEqual(local["source"], published["source"])
            write_json(manifest_path, local)
            with self.assertRaisesRegex(ValueError, "scene bundle differs from the pinned release"):
                config.reference(assets, assets, catalog, release)

    def test_default_libero_reference_passes_simulator_asset_preflight(self):
        spec = importlib.util.spec_from_file_location("native_embodied_run", ADAPTER.with_name("run.py"))
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        request = {"reference": json.loads(ADAPTER.with_name("reference.json").read_text())}
        self.assertNotIn("environment", request["reference"])
        runner.verify_simulator_assets([request])
        runner.verify_simulator_assets([request, request])

    def test_chores_preparation_and_registration_require_the_published_archive(self):
        path = ADAPTER.parent / "benchmarks/chores/configure_chores.py"
        spec = importlib.util.spec_from_file_location("configure_chores_fixture", path)
        config = importlib.util.module_from_spec(spec)
        with patch.object(sys, "path", sys.path.copy()):
            spec.loader.exec_module(config)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "assets.tar"
            prepared = root / "prepared"
            catalog = {"ObjectNavType:000": {"house_index": 0, "task_type": "ObjectNavType",
                                            "natural_language_spec": "Find the cube."}}
            for name, value in (("val.jsonl.gz", {"objects": [{"assetId": "cube"}]}),
                                ("annotations.json.gz", {"cube": {}})):
                with gzip.open(root / name, "wt", encoding="utf-8") as stream:
                    stream.write(json.dumps(value) + "\n")
            for name in ("online_evaluation/max_episode_configs.py", "tasks/multi_task_eval_sampler.py"):
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("# fixture\n")

            def write_archive(texture):
                with tarfile.open(archive, "w") as tar:
                    for name, content in (("cube.json", b"{}"), ("albedo.jpg", texture)):
                        member = tarfile.TarInfo(f"processed_2023_07_28/cube/{name}")
                        member.size = len(content)
                        tar.addfile(member, io.BytesIO(content))

            write_archive(b"original")
            release = {"catalog": {}, "thor": "fixture", "assetArchiveBytes": archive.stat().st_size,
                       "assets": {name: adapter.file_digest(root / name)
                                  for name in ("assets.tar", "val.jsonl.gz", "annotations.json.gz")}}
            with patch.object(config, "read_catalog", return_value=catalog):
                config.prepare(root, prepared, release)
                manifest_path = prepared / "manifest.json"
                manifest = json.loads(manifest_path.read_text())
                self.assertEqual(manifest["inputs"], release["assets"])
                config.reference(root, root, prepared, "chores-small", release)

                write_archive(b"modified")
                self.assertEqual(archive.stat().st_size, release["assetArchiveBytes"])
                with self.assertRaisesRegex(ValueError, "release file differs: assets.tar"):
                    config.prepare(root, root / "rejected", release)
                self.assertFalse((root / "rejected").exists())
                manifest["inputs"]["assets.tar"] = adapter.file_digest(archive)
                write_json(manifest_path, manifest)
                with self.assertRaisesRegex(ValueError, "asset bundle was prepared from different releases"):
                    config.reference(root, root, prepared, "chores-small", release)

    def test_chores_preflight_checks_prepared_object_files_for_selected_houses(self):
        spec = importlib.util.spec_from_file_location("native_embodied_run", ADAPTER.with_name("run.py"))
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            chair, bowl = (root / "assets" / uid for uid in ("chair", "bowl"))
            chair.mkdir(parents=True)
            bowl.mkdir()
            (chair / "chair.pkl.gz").write_bytes(b"mesh and collider")
            texture = chair / "albedo.jpg"
            texture.write_bytes(b"published texture")
            bowl_model = bowl / "bowl.pkl.gz"
            bowl_model.write_bytes(b"published bowl")
            manifest = {"version": 2,
                        "houses": {"7": {"assetIds": ["chair", "native"]},
                                   "8": {"assetIds": ["chair", "bowl"]}},
                        "objectDigests": {"chair": tree_digest(chair), "bowl": tree_digest(bowl), "native": None}}
            write_json(root / "manifest.json", manifest)
            reference = {"environment": {"kind": "chores", "assets": {"target": str(root), "digest": digest(manifest)},
                                         "catalog": {"task-a": {"house_index": 7}, "task-b": {"house_index": 8}}}}
            first, second = [{"reference": reference, "sample": {"taskId": task}} for task in ("task-a", "task-b")]
            with patch("orbit_embodied.chores.tree_digest", wraps=tree_digest) as measured:
                runner.verify_simulator_assets([first, second, first])
                self.assertCountEqual([call.args[0] for call in measured.call_args_list], [chair, bowl])
            texture.write_bytes(b"changed texture")
            with self.assertRaisesRegex(ValueError, "mounted object asset differs: chair"):
                runner.verify_simulator_assets([first])
            texture.write_bytes(b"published texture")
            bowl_model.unlink()
            bowl.rmdir()
            runner.verify_simulator_assets([first])
            with self.assertRaisesRegex(ValueError, "mounted object asset differs: bowl"):
                runner.verify_simulator_assets([first, second])

    def test_policy_build_exports_the_pinned_source_and_labels_the_image(self):
        with patch.object(sys, "path", [str(ADAPTER.parent), *sys.path]):
            import native_runtime

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checkout = root / "upstream"
            subprocess.run(["git", "init", "--quiet", str(checkout)], check=True)
            code = checkout / "inference.py"
            code.write_text("pinned\n")
            subprocess.run(["git", "-C", str(checkout), "add", code.name], check=True)
            subprocess.run(["git", "-C", str(checkout), "-c", "user.name=Orbit Test",
                            "-c", "user.email=orbit@example.invalid", "-c", "commit.gpgsign=false",
                            "commit", "--quiet", "-m", "Pin test policy source"], check=True)
            commit = subprocess.check_output(["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True).strip()
            source = {"repository": "synthetic", "commit": commit}
            native_runtime.check_policy_source(checkout, source)
            code.write_text("local edit\n")
            with self.assertRaisesRegex(ValueError, "clean pinned policy checkout"):
                native_runtime.check_policy_source(checkout, source)

            dockerfile, server = root / "policy.Dockerfile", root / "server.py"
            dockerfile.write_text("FROM scratch\n")
            server.write_text("server\n")
            manifest = native_runtime.policy_manifest("synthetic-policy", {"model": source}, dockerfile, server)
            self.assertEqual(manifest["sources"], {"model": commit})
            self.assertEqual(manifest["server"], adapter.file_digest(server))
            self.assertEqual(manifest["sdk"]["wire.py"], adapter.file_digest(ROOT / "examples/sdk/orbit_embodied/wire.py"))
            self.assertNotIn("test_wire.py", manifest["sdk"])
            run = subprocess.run
            builds = []

            def capture_build(command, **kwargs):
                if command[:2] == ["docker", "build"]:
                    context = command[command.index("--build-context") + 1].split("=", 1)[1]
                    self.assertEqual((Path(context) / code.name).read_text(), "pinned\n")
                    label = next(arg for arg in command if arg.startswith(native_runtime.MANIFEST_LABEL + "="))
                    self.assertEqual(json.loads(label.split("=", 1)[1]), manifest)
                    builds.append(command)
                else:
                    return run(command, **kwargs)

            args = SimpleNamespace(source=checkout, policy_base="synthetic:base", build_tag="synthetic:policy")
            with patch.object(native_runtime.subprocess, "run", side_effect=capture_build):
                native_runtime.build_policy_image(args, "model", source, dockerfile, manifest)
            self.assertEqual(len(builds), 1)

    def test_native_runtime_images_require_matching_manifest_and_entrypoint(self):
        with patch.object(sys, "path", [str(ADAPTER.parent), *sys.path]):
            import native_runtime

        mt100 = native_runtime.runtime_manifest("rlbench-mt100", native_runtime.rlbench_sources(False))
        rvt = native_runtime.runtime_manifest("rlbench-rvt18", native_runtime.rlbench_sources(True))
        casa = native_runtime.runtime_manifest("robocasa-v02", native_runtime.robocasa_sources())
        image_id = "sha256:" + "a" * 64
        for expected, actual, entrypoint in (
            (mt100, mt100, mt100["entrypoint"]),
            (rvt, rvt, rvt["entrypoint"]),
            (casa, casa, casa["entrypoint"]),
            (mt100, casa, casa["entrypoint"]),
            (mt100, rvt, rvt["entrypoint"]),
            (casa, None, casa["entrypoint"]),
            (rvt, rvt, ["python"]),
            (mt100, {**mt100, "coppeliasim": "wrong"}, mt100["entrypoint"]),
        ):
            labels = {native_runtime.MANIFEST_LABEL: json.dumps(actual)} if actual else {}
            config = {"Labels": labels, "Entrypoint": entrypoint}
            output = json.dumps([{"Id": image_id, "Config": config}])
            with self.subTest(kind=expected["kind"], actual=actual, entrypoint=entrypoint):
                with patch.object(native_runtime.subprocess, "check_output", return_value=output):
                    if expected == actual and entrypoint == expected["entrypoint"]:
                        self.assertEqual(native_runtime.require_image("tag", expected), image_id)
                    else:
                        with self.assertRaisesRegex(ValueError, "expected the pinned"):
                            native_runtime.require_image("tag", expected)

    def test_vima_policy_image_requires_the_packaged_sdk_manifest(self):
        with patch.object(sys, "path", [str(ADAPTER.parent / "benchmarks"), *sys.path]):
            import configure_manipulation
            import native_runtime

        with tempfile.TemporaryDirectory() as temporary, patch.object(configure_manipulation, "SDK", Path(temporary)):
            sdk = Path(temporary) / "orbit_embodied"
            sdk.mkdir()
            wire = sdk / "wire.py"
            wire.write_text("original")
            test = sdk / "test_wire.py"
            test.write_text("test")
            sources = {}
            policy = configure_manipulation.manifest("vima-bench", sources, "policy")
            simulator = configure_manipulation.manifest("vima-bench", sources, "simulator")
            self.assertEqual(policy["sdk"], {"wire.py": adapter.file_digest(wire)})
            self.assertNotIn("sdk", simulator)
            image_id = "sha256:" + "a" * 64
            image = json.dumps([{"Id": image_id, "Config": {
                "Labels": {native_runtime.MANIFEST_LABEL: json.dumps(policy)},
                "Entrypoint": policy["entrypoint"],
            }}])
            with patch.object(native_runtime.subprocess, "check_output", return_value=image):
                self.assertEqual(native_runtime.require_image("tag", policy), image_id)
                test.write_text("changed test")
                unchanged = configure_manipulation.manifest("vima-bench", sources, "policy")
                self.assertEqual(native_runtime.require_image("tag", unchanged), image_id)
                for filename, content in (("wire.py", "modified"), ("codec.py", "added"), ("wire.py", None)):
                    with self.subTest(filename=filename, content=content):
                        path = sdk / filename
                        if content is None:
                            path.unlink()
                        else:
                            path.write_text(content)
                        expected = configure_manipulation.manifest("vima-bench", sources, "policy")
                        with self.assertRaisesRegex(ValueError, "matching build manifest"):
                            native_runtime.require_image("tag", expected)
                        self.assertEqual(configure_manipulation.manifest("vima-bench", sources, "simulator"), simulator)
                        if path == wire:
                            wire.write_text("original")
                        else:
                            path.unlink()

    def batch_request(self, root):
        request = self.request(root)
        first = request["trial"]
        second = copy.deepcopy(first)
        second.update(id="synthetic-second", staging=str(root / "second-staging"))
        content = {key: value for key, value in second["sample"].items() if key != "sampleId"}
        content["initialStateId"] = "1"
        second["sample"] = {**content, "sampleId": digest(content)}
        second["sampleRef"] = second["sample"]["sampleId"]
        content = {"version": 1, "id": "synthetic-batch", "attemptId": "attempt", "method": "synthetic-policy",
                   "randomness": "service", "members": [
                       {"trialId": trial["id"], "sampleRef": trial["sampleRef"], "episodeId": trial["id"] + ".attempt"}
                       for trial in (first, second)]}
        plan = {**content, "digest": digest(content)}
        for index, trial in enumerate((first, second)):
            trial["batch"] = {"plan": plan, "index": index}
        request["batch"] = {"plan": plan, "trials": [first, second]}
        spec = request["solve"]["run"]["spec"]
        spec["params"]["batchDigest"] = plan["digest"]
        spec["tags"].update(embodied_evidence="3", execution_batch=plan["id"], batch_attempt=plan["attemptId"])
        return request

    def test_solve_checks_the_mounted_simulator_assets_once_before_execution(self):
        for kind, operation in product(("libero-plus", "vlabench"), ("solve", "batch")):
            with self.subTest(kind=kind, operation=operation), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                staging = adapter.stage({"trial": {"staging": str(root / "stage")}})
                spec = importlib.util.spec_from_file_location("staged_run", staging / "run.py")
                run = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(run)
                assets = root / "assets"
                assets.mkdir()
                asset = assets / "texture"
                asset.write_bytes(b"frozen texture")
                checksum = run.tree_digest(assets)
                reference = {"environment": {"kind": kind, "assets": {
                    "target": str(assets), "digest": checksum,
                }}}
                episode = {"implementationDigest": "driver"}
                payload = {"reference": reference, "referenceDigest": digest(reference),
                           **(episode if operation == "solve" else {"plan": {}, "episodes": [episode, episode]})}
                request = root / "request.json"
                write_json(request, payload)
                def prepare_only(request, destination, *, prepare):
                    prepare()

                def batch_prepare_only(plan, episodes, output, execute):
                    for episode in episodes:
                        execute(episode, output)

                with patch.dict(run.SIMULATOR_ASSET_ROOTS, {kind: str(assets)}), \
                        patch.object(run, "archive_implementation", return_value="driver"), \
                        patch.object(run, "tree_digest", wraps=run.tree_digest) as measure, \
                        patch.object(run, "execute_episode", side_effect=prepare_only), \
                        patch("orbit_embodied.batch.run_batch", side_effect=batch_prepare_only):
                    argv = [operation, str(request), str(root / "output")]
                    run.main(argv)
                    measure.assert_called_once_with(str(assets))
                    asset.write_bytes(b"changed texture")
                    with self.assertRaisesRegex(ValueError, "mounted simulator asset digest mismatch"):
                        run.main(argv)
                    self.assertEqual(measure.call_count, 2)

    def test_robolab_and_plate25_prepare_runtime_once_per_solve(self):
        from orbit_embodied import robolab, tabletop

        spec = importlib.util.spec_from_file_location("native_embodied_run", ADAPTER.with_name("run.py"))
        run = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(run)

        for kind, batched in product(("robolab", "maniskill3"), (False, True)):
            with self.subTest(kind=kind, batched=batched), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                assets = root / "assets"
                assets.mkdir()
                asset = assets / "scene"
                asset.write_text("frozen assets")
                version_file = root / "VERSION"
                version_file.write_text("5.0.0")
                lab = root / "isaaclab"
                (lab / "source/isaaclab/config").mkdir(parents=True)
                (lab / "VERSION").write_text("fixture")
                (lab / "source/isaaclab/config/extension.toml").write_text("fixture")
                environment = {"kind": kind, "tasks": ["fixture"], "horizon": 2, "version": "3.0.1",
                               "assets": {"target": str(assets), "digest": tree_digest(assets)},
                               "sourceRoot": str(root), "isaacLabPackageVersion": "0.44.8",
                               "isaacLabSource": {"root": str(lab), "digest": robolab.isaaclab_source_digest(lab)},
                               "isaacSimVersionFile": str(version_file), "isaacSim": "5.0.0"}
                reference = {"id": "fixture", "environment": environment, "reference": {"files": {}},
                             "benchmarkProfile": {"action": {"shape": [8]}},
                             "parameters": {"settleSteps": 0, "replanSteps": 5}}
                episodes = [{"sample": {"taskId": "fixture", "benchmarkProfile": "fixture", "sampleId": str(index)},
                             "trialId": str(index), "episodeId": str(index), "implementationDigest": "driver",
                             "policy": {"connector": "policy-ws"}, "binding": {}}
                            for index in range(2)]
                plan = {"members": [{"trialId": episode["trialId"], "episodeId": episode["episodeId"],
                                     "sampleRef": episode["sample"]["sampleId"]} for episode in episodes]}
                payload = {"reference": reference, "referenceDigest": digest(reference),
                           **({"plan": {**plan, "digest": digest(plan)}, "episodes": episodes} if batched else episodes[0])}
                request = root / "request.json"
                write_json(request, payload)

                start = Mock(side_effect=RuntimeError("synthetic simulator entry point"))
                module = robolab if kind == "robolab" else tabletop

                def run_fixture(benchmark, *args, prepare, **kwargs):
                    prepare()
                    with self.assertRaisesRegex(RuntimeError, "synthetic simulator entry point"):
                        benchmark.make_env(0)
                    return {"valid": True}

                with patch.object(run, "archive_implementation", return_value="driver"), \
                        patch.object(run, "run_episode", side_effect=run_fixture), \
                        patch.object(module, "tree_digest", wraps=tree_digest) as measure, \
                        patch.object(module, "version", return_value="0.44.8" if kind == "robolab" else "3.0.1"), \
                        patch.object(robolab, "simulation_app", start), \
                        patch.dict(sys.modules, {"gymnasium": SimpleNamespace(make=start),
                                                 "orbit_maniskill_task": SimpleNamespace()}), \
                        patch.dict("os.environ", {"ORBIT_RUN_ID": "fixture"}):
                    argv = ["batch" if batched else "solve", str(request), str(root / "output")]
                    run.main(argv)
                    self.assertEqual(measure.call_count, 1)
                    self.assertEqual(Path(measure.call_args.args[0]), assets)
                    self.assertEqual(start.call_count, 2 if batched else 1)
                    start.reset_mock()
                    asset.write_text("edited assets")
                    with self.assertRaisesRegex(ValueError, "asset digest mismatch"):
                        run.main(argv)
                    self.assertEqual(measure.call_count, 2)
                    start.assert_not_called()

    def test_versioned_evidence_cannot_skip_the_solve_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            staging = adapter.stage({"trial": {"staging": str(root / "stage")}})
            spec = importlib.util.spec_from_file_location("staged_run", staging / "run.py")
            run = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(run)
            episode = root / "solve/episode"
            write_json(episode / "contract.json", {"identity": {"implementationDigest": "sha256:" + "0" * 64}})
            expected = {"sample": {"sampleId": "synthetic"}, "evidenceVersion": 2,
                        "verifierDigest": archive_implementation(staging, root / "probe")}
            write_json(root / "expected.json", expected)
            with self.assertRaisesRegex(ValueError, "lacks its implementation archive"):
                run.main(["verify", str(episode), str(root / "out/verified.json"), str(root / "expected.json")])

    def test_verifier_accepts_a_libero_reference_without_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            adapter.verify(request)
            staging = Path(request["trial"]["staging"])
            spec = importlib.util.spec_from_file_location("staged_run", staging / "run.py")
            run = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(run)
            solve = Path(request["solve"]["output"])
            episode = solve / "episode"
            fingerprint = archive_implementation(staging, solve / "implementation")
            write_json(episode / "contract.json", {"identity": {"implementationDigest": fingerprint,
                                                                  "implementationArchive": True}})
            result = {"episodeId": "synthetic-trial.attempt", "valid": True, "success": True}
            write_json(episode / "native-result.json", result)
            output = root / "out/verified.json"
            with patch.object(run, "verify_episode", return_value=result):
                run.main(["verify", str(episode), str(output), str(staging / "verify-request.json")])
            self.assertEqual(json.loads(output.read_text()), result)
            self.assertTrue(output.with_name("verification.json").is_file())
            self.assertFalse(output.with_name("orbit-trajectory.json").exists())

    def test_native_verifier_writes_new_episode_views_without_changing_the_verdict(self):
        from orbit_embodied.test_episode_trajectory import episode, expectation

        for kind, state, action_size in (
            ("robodojo", {"joint_state": [0.0] * 14, "instruction": "Synthetic task"}, 14),
            ("robolab", {"joint_position": [0.0] * 7, "gripper_position": [1.0]}, 8),
        ):
            for valid, broken_index in ((True, False), (False, False), (True, True)):
                with self.subTest(kind=kind, valid=valid, broken_index=broken_index), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    staging = adapter.stage({"trial": {"staging": str(root / "stage")}})
                    spec = importlib.util.spec_from_file_location("trajectory_run", staging / "run.py")
                    run = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(run)
                    directory = root / "solve/episode"
                    directory.mkdir(parents=True)
                    episode(directory, [state] * 2, action=[0.0] * action_size, horizon=2, initial=state)
                    identity = {}
                    expected = expectation(kind + "-native.json", "synthetic")
                    expected["sample"]["sampleId"] = "synthetic-sample"
                    expected.update(evidenceVersion=1, solveRunId="synthetic-solve", trialId="synthetic-trial",
                                    verifierDigest=archive_implementation(staging, directory.parent / "implementation"))
                    if kind == "robolab":
                        reference = expected.pop("reference")
                        expected.update(referenceDigest=digest(reference), evidenceVersion=2)
                        identity.update(referenceDigest=expected["referenceDigest"], implementationArchive=True,
                                        implementationDigest=expected["verifierDigest"])
                        write_json(directory.parent / "reference.json", reference)
                    write_json(directory / "contract.json", {"horizon": 2, "identity": identity})
                    write_json(root / "expected.json", expected)
                    result = {"episodeId": "synthetic-trial.attempt", "valid": valid, "success": False, "issues": []}
                    write_json(directory / "native-result.json", result)
                    if broken_index:
                        (directory / "chunks/0.json").unlink()
                    output = root / "out/verified.json"
                    # Verification is explicit synthetic setup; exercise the real index writer and entry point.
                    with patch.object(run, "verify_episode", return_value=result):
                        run.main(["verify", str(directory), str(output), str(root / "expected.json")])
                    self.assertEqual(json.loads(output.read_text()), result)
                    self.assertEqual(output.with_name("orbit-trajectory.json").exists(), valid and not broken_index)

    def test_fixed_batch_has_one_run_and_independent_episode_verification(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.batch_request(root)
            reference = json.loads(request["benchmark"]["config"]["reference"])
            with patch.object(adapter, "settings", return_value=(root, request["benchmark"]["config"], reference)):
                reply = adapter.solve(request)["spec"]
            self.assertEqual(reply["command"][1], "batch")
            self.assertEqual(reply["timeoutMin"], 40)
            self.assertEqual(reply["tags"]["embodied_evidence"], "3")
            payload = json.loads((root / "staging/batch-request.json").read_text())
            self.assertEqual(payload["reference"], reference)
            self.assertEqual(payload["referenceDigest"], reply["tags"]["embodied_reference"])
            self.assertEqual([item["sample"]["initialStateId"] for item in payload["episodes"]], ["0", "1"])
            self.assertTrue(all("reference" not in item and "batch" not in item for item in payload["episodes"]))
            self.assertFalse((root / "staging/request.json").exists())
            self.assertFalse((root / "second-staging").exists())
            request["solve"]["run"]["spec"]["tags"].update(reply["tags"])
            request["trial"] = request["batch"]["trials"][1]
            request["trial"]["id"] = "consolidated-second"
            verify = adapter.verify(request)["spec"]
            self.assertIn("/solve/episodes/synthetic-second.attempt", verify["command"])
            expected = json.loads((root / "second-staging/verify-request.json").read_text())
            self.assertEqual(expected["executionTrialId"], "synthetic-second")
            self.assertEqual(expected["batch"]["index"], 1)
            self.assertEqual(expected["referenceDigest"], digest(reference))
            self.assertNotIn("reference", expected)
            self.assertEqual(verify["resources"]["gpus"], 0)
            self.assertNotIn("services", verify)

    def test_solve_archives_one_reference_and_verifies_each_episode(self):
        from orbit_embodied.test_core import SyntheticBenchmark, SyntheticPolicy

        for batched in (False, True):
            with self.subTest(batched=batched), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                request = self.batch_request(root) if batched else self.request(root)
                config = request["benchmark"]["config"]
                trials = request["batch"]["trials"] if batched else [request["trial"]]
                profile = {"id": "synthetic/1", "observations": {
                    "state": {"semantic": "fixture-state", "dtype": "float64", "shape": [3]},
                }, "action": json.loads(config["reference"])["benchmarkProfile"]["action"]}
                reference = {"id": trials[0]["sample"]["benchmarkProfile"], "benchmarkProfile": profile,
                             "observationMap": {"state": "state"}, "horizons": {"synthetic": 7},
                             "parameters": {"settleSteps": 0, "replanSteps": 5, "renderSize": 256}}
                config.update(reference=json.dumps(reference), profileDigest=digest(reference))
                for trial in trials:
                    trial["binding"] = resolve_binding(profile, profile, reference["observationMap"])
                    trial["method"]["policySnapshot"] = {"profile": profile, "connector": "policy-ws"}
                with patch.object(adapter, "settings", return_value=(root, config, reference)):
                    solve = adapter.solve(request)["spec"]
                staging = root / "staging"
                spec = importlib.util.spec_from_file_location("staged_run", staging / "run.py")
                run = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(run)
                request["solve"]["run"]["spec"]["tags"].update(solve["tags"])
                output = Path(request["solve"]["output"])

                def benchmark(*args, **kwargs):
                    endpoint = SyntheticBenchmark(success_at=1)
                    endpoint.settle_steps = 0
                    return endpoint

                mode, payload = ("batch", "batch-request.json") if batched else ("solve", "request.json")
                destination = output if batched else output / "episode"
                with patch("orbit_embodied.libero.LiberoBenchmark", side_effect=benchmark), \
                        patch.object(run, "LazyPolicy", side_effect=lambda _: SyntheticPolicy()), \
                        patch.dict("os.environ", {"ORBIT_RUN_ID": "source-run"}):
                    run.main([mode, str(staging / payload), str(destination)])
                self.assertEqual(list(output.rglob("reference.json")), [output / "reference.json"])
                self.assertEqual(json.loads((output / "reference.json").read_text()), reference)
                for index, trial in enumerate(trials):
                    request["trial"] = trial
                    episode = output / adapter.episode_path(request)
                    identity = json.loads((episode / "contract.json").read_text())["identity"]
                    self.assertNotIn("reference", identity)
                    self.assertEqual(identity["referenceDigest"], digest(reference))
                    adapter.verify(request)
                    expected = Path(trial["staging"]) / "verify-request.json"
                    verify = root / f"verify-{index}"
                    args = ["verify", str(episode), str(verify / "verified.json"), str(expected)]
                    run.main(args)
                    self.assertEqual(adapter.score({**request, "verify": {"output": str(verify)}})["score"], 1)
                write_json(output / "reference.json", {**reference, "other": True})
                with self.assertRaisesRegex(ValueError, "shared reference digest"):
                    run.main(args)

    def test_diffusion_solve_requires_native_done_evidence_with_or_without_batch(self):
        for batched in (False, True):
            with self.subTest(batched=batched), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                request = self.batch_request(root) if batched else self.request(root)
                config = request["benchmark"]["config"]
                reference = json.loads(config["reference"])
                reference["environment"] = {"protocol": "diffusion-policy"}
                config.update(reference=json.dumps(reference), profileDigest=digest(reference))
                with patch.object(adapter, "settings", return_value=(root, config, reference)):
                    solve = adapter.solve(request)["spec"]
                self.assertEqual(solve["tags"]["embodied_evidence"], "4")
                request["solve"]["run"]["spec"]["tags"]["embodied_evidence"] = "4"
                expected = adapter.verification_expectation(request)
                self.assertEqual(expected["evidenceVersion"], 4)
                self.assertEqual("batch" in expected, batched)

    def test_batch_verification_rejects_other_episode_or_attempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            request = self.batch_request(Path(temporary))
            for field in ("batch_attempt", "execution_batch"):
                changed = copy.deepcopy(request)
                changed["solve"]["run"]["spec"]["tags"][field] = "other"
                with self.subTest(field=field), self.assertRaisesRegex(ValueError, "batch attempt"):
                    adapter.verify(changed)
            request["trial"]["batch"]["index"] = 1
            with self.assertRaisesRegex(ValueError, "batch attempt"):
                adapter.verify(request)

    def request(self, root):
        reference = json.loads((ADAPTER.parent / "reference.json").read_text())
        content = {"taskId": "synthetic:task", "benchmarkProfile": reference["id"],
                   "initialStateId": "0", "initialStateDigest": "sha256:" + "a" * 64,
                   "environmentSeed": 7, "policySeed": 0, "repetition": 0}
        sample = {**content, "sampleId": digest(content)}
        return {"benchmark": {"config": {"image": "sha256:" + "a" * 64,
                "reference": json.dumps(reference), "profileDigest": digest(reference),
                "implementationDigest": adapter.implementation_digest()}}, "trial": {
            "id": "synthetic-trial", "task": content["taskId"], "sampleRef": sample["sampleId"],
            "sample": sample,
            "binding": resolve_binding(reference["benchmarkProfile"], reference["policyProfile"], reference["observationMap"]),
            "method": {"name": "synthetic-policy", "policySnapshot": {"profile": reference["policyProfile"]}},
            "staging": str(root / "staging")},
            "solve": {"output": str(root / "solve-output"), "run": {"id": "source-run", "spec": {
                "params": {"sampleRef": sample["sampleId"], "task": content["taskId"],
                           "method": "synthetic-policy", "phase": "solve"},
                "tags": {"trial": "synthetic-trial", "embodied_evidence": "2"}}}}}

    def test_native_plan_keeps_model_service_in_orbit_and_preserves_runtime_imports(self):
        reference = json.loads((ADAPTER.parent / "reference.json").read_text())
        binding = resolve_binding(reference["benchmarkProfile"], reference["policyProfile"], reference["observationMap"])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            config = request["benchmark"]["config"]
            with patch.object(adapter, "settings", return_value=(root, config, reference)):
                solve = adapter.solve(request)["spec"]
            self.assertNotIn("services", solve)
            self.assertEqual(solve["tags"]["embodied_evidence"], "2")
            self.assertIn("/app/third_party/libero", solve["env"]["PYTHONPATH"])
            self.assertIn("/app/packages/openpi-client/src", solve["env"]["PYTHONPATH"])
            self.assertEqual(solve["env"]["MUJOCO_GL"], solve["env"]["PYOPENGL_PLATFORM"])
            staged = json.loads((root / "staging/request.json").read_text())
            self.assertEqual(staged["binding"], binding)
            self.assertTrue(staged["episodeId"].startswith("synthetic-trial."))
            archive = root / "implementation"
            measured = archive_implementation(root / "staging", archive)
            self.assertEqual(measured, config["implementationDigest"])
            verify_implementation(archive, measured)
            (archive / "run.py").write_text("# altered driver\n")
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                verify_implementation(archive, measured)
            verifier = adapter.verify(request)["spec"]
            self.assertEqual(verifier["resources"]["gpus"], 0)
            self.assertNotIn("services", verifier)
            self.assertFalse(verifier["network"])

    def test_restaging_drops_removed_sdk_modules_without_removing_trial_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = {"trial": {"staging": str(root / "staging")}}
            staging = adapter.stage(request)
            removed = staging / "python/orbit_embodied/removed.py"
            removed.write_text("# previous SDK version\n")
            payload = staging / "request.json"
            payload.write_text("{}")

            adapter.stage(request)
            self.assertFalse(removed.exists())
            self.assertEqual(payload.read_text(), "{}")
            measured = archive_implementation(staging, root / "implementation")
            self.assertEqual(measured, adapter.implementation_digest())

    def test_navigation_solve_pins_one_gpu_and_verify_uses_cpu(self):
        profile_modules = (
            ("chores", "vulkan", "chores", "navigation_pose", "image"),
            ("hssd-ov", "egl", "hssd_ov", "agent_position", None),
        )
        for kind, renderer, module, diagnostic, workdir in profile_modules:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                benchmark = __import__("orbit_embodied." + module, fromlist=["semantic_profile"])
                profile = benchmark.semantic_profile()
                observations = {name: field for name, field in profile["observations"].items() if name != diagnostic}
                policy_profile = {**profile, "observations": observations}
                mapping = {name: name for name in observations}
                root = Path(temporary)
                request = self.request(root)
                trial = request["trial"]
                task = trial["sample"]["taskId"]
                asset = trial["sample"]["initialStateDigest"]
                reference = {
                    "id": kind + "/1", "benchmarkProfile": profile, "observationMap": mapping,
                    "parameters": {"settleSteps": 0, "replanSteps": 1},
                    "environment": {"kind": kind, "tasks": [task], "initialStateCounts": {task: 1},
                                    "initialStateDigests": {task: asset}, "horizon": 500, "environmentSeed": 7,
                                    "assets": {"dataset": kind, "target": "/" + kind, "digest": asset}},
                }
                sample = {key: value for key, value in trial["sample"].items() if key != "sampleId"}
                sample["benchmarkProfile"] = reference["id"]
                sample["sampleId"] = digest(sample)
                trial.update(options={"gpuId": "GPU-explicit"}, sample=sample, sampleRef=sample["sampleId"],
                             binding=resolve_binding(profile, policy_profile, mapping))
                trial["method"]["policySnapshot"]["profile"] = policy_profile
                request["solve"]["run"]["spec"]["params"]["sampleRef"] = sample["sampleId"]
                config = request["benchmark"]["config"]
                config.update(reference=json.dumps(reference), profileDigest=digest(reference), renderer=renderer,
                              simGpus="1")
                with patch.object(adapter, "settings", return_value=(root, config, reference)):
                    solve = adapter.solve(request)["spec"]
                    self.assertEqual(solve["resources"]["gpuIds"], ["GPU-explicit"])
                    self.assertEqual(solve.get("workdir"), workdir)
                    self.assertEqual(solve["mounts"][-1]["dataset"], kind)
                    trial["options"]["gpuId"] = "two,devices"
                    with self.assertRaisesRegex(ValueError, "a single GPU"):
                        adapter.solve(request)
                verify = adapter.verify(request)["spec"]
                self.assertEqual(verify["resources"]["gpus"], 0)
                self.assertFalse(any("dataset" in mount for mount in verify["mounts"]))

    def test_chores_catalog_reports_distinct_suite_variants(self):
        from orbit_embodied.chores import semantic_profile

        for suite, variant in (("chores-small", "CHORES-S"), ("chores-large", "CHORES-L")):
            reference = {"id": suite + "/1", "benchmarkProfile": semantic_profile(),
                         "observationMap": {}, "parameters": {"replanSteps": 1},
                         "environment": {"kind": "chores", "tasks": []},
                         "reference": {"evaluation": {"commit": "synthetic"}}}
            with self.subTest(suite=suite), patch.object(adapter, "settings", return_value=(
                    Path("."), {"suite": suite, "image": "synthetic"}, reference)):
                listing = adapter.tasks({})
            self.assertEqual(listing["capabilities"]["identity"],
                             {"id": "chores", "name": "CHORES", "variant": variant})

    def test_fixed_native_catalog_keeps_seed_and_state_index_independent(self):
        asset = "sha256:" + "b" * 64
        reference = {"environment": {"kind": "vla-arena", "environmentSeed": 7,
                                     "initialStateCounts": {"task": 2},
                                     "initialStateDigests": {"task": asset}}}
        first = {"taskId": "task", "initialStateId": "0", "environmentSeed": 7, "policySeed": 0,
                 "repetition": 0, "sampleId": "first"}
        second = {**first, "initialStateId": "1", "sampleId": "second"}
        self.assertEqual(seed_asset(reference, "task"), asset)
        self.assertEqual(reset_seed(second, reference), 7)
        check_distinct_resets([first, second], reference)
        for invalid in ({**second, "initialStateId": "2"}, {**second, "environmentSeed": 8}):
            with self.assertRaisesRegex(ValueError, "frozen initial-state"):
                reset_seed(invalid, reference)
        with self.assertRaisesRegex(ValueError, "same native reset"):
            check_distinct_resets([first, {**first, "sampleId": "aliased"}], reference)

    def test_robocasa_plans_task_horizons_and_mounts_assets_only_for_solve(self):
        reference = json.loads((ADAPTER.parent / "profiles/robocasa365-atomic-seen.json").read_text())
        assets = reference["environment"]["assets"]
        assets["digest"] = "sha256:" + "b" * 64
        task = "robocasa/OpenDrawer"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            config = request["benchmark"]["config"]
            config.update(reference=json.dumps(reference), profileDigest=digest(reference))
            trial = request["trial"]
            trial["task"] = task
            content = {key: value for key, value in trial["sample"].items() if key != "sampleId"}
            content.update(taskId=task, benchmarkProfile=reference["id"], initialStateDigest=seed_asset(reference, task))
            trial["sample"] = {**content, "sampleId": digest(content)}
            trial["sampleRef"] = trial["sample"]["sampleId"]
            profile = {**reference["benchmarkProfile"], "id": "synthetic-robocasa-policy/1"}
            trial["method"]["policySnapshot"]["profile"] = profile
            trial["binding"] = resolve_binding(reference["benchmarkProfile"], profile, reference["observationMap"])
            request["solve"]["run"]["spec"]["params"].update(task=task, sampleRef=trial["sampleRef"])
            with patch.object(adapter, "settings", return_value=(root, config, reference)):
                catalog = adapter.tasks(request)
                solve = adapter.solve(request)["spec"]
            self.assertEqual(len(catalog["tasks"]), 18)
            self.assertEqual(catalog["official"]["unit"], "task")
            self.assertEqual(reference_horizon(reference, task), 750)
            self.assertEqual(reference_horizon(reference, "robocasa/OpenStandMixerHead"), 450)
            self.assertEqual(solve["mounts"][-1], {"dataset": assets["dataset"], "target": assets["target"], "mode": "ro"})
            self.assertFalse(any("dataset" in mount for mount in adapter.verify(request)["spec"]["mounts"]))

    def test_second_model_profile_reuses_the_same_libero_benchmark(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            reference = json.loads(request["benchmark"]["config"]["reference"])
            profile = request["trial"]["method"]["policySnapshot"]["profile"]
            profile["id"] = "groot-libero-input/1"
            request["trial"]["binding"] = resolve_binding(reference["benchmarkProfile"], profile, reference["observationMap"])
            with patch.object(adapter, "settings", return_value=(root, request["benchmark"]["config"], reference)):
                adapter.solve(request)
            staged = json.loads((root / "staging/request.json").read_text())
            self.assertEqual(staged["reference"], reference)
            self.assertEqual(staged["binding"]["policyProfile"]["id"], "groot-libero-input/1")

    def test_verifier_uses_frozen_context_and_original_execution_trial(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            request["trial"]["id"] = "consolidated-trial"
            tags = request["solve"]["run"]["spec"]["tags"]
            tags.update(trial="consolidated-trial", source_trial="intermediate-trial", execution_trial="synthetic-trial")
            request["benchmark"]["config"]["implementationDigest"] = "sha256:" + "b" * 64
            adapter.verify(request)
            expected = json.loads((root / "staging/verify-request.json").read_text())
            self.assertEqual(expected["solveRunId"], "source-run")
            self.assertEqual(expected["executionTrialId"], "synthetic-trial")
            self.assertEqual(expected["sample"], request["trial"]["sample"])
            self.assertEqual(expected["binding"], request["trial"]["binding"])
            self.assertEqual(expected["solveImplementationDigest"], "sha256:" + "b" * 64)
            del tags["execution_trial"]
            self.assertEqual(adapter.verification_expectation(request)["executionTrialId"], "intermediate-trial")
            for key in ("sampleRef", "task", "method", "phase"):
                changed = copy.deepcopy(request)
                changed["solve"]["run"]["spec"]["params"][key] = "other"
                with self.subTest(key=key), self.assertRaisesRegex(ValueError, "solve Run differs"):
                    adapter.verify(changed)
            del request["trial"]["binding"]
            with self.assertRaisesRegex(ValueError, "missing frozen"):
                adapter.verify(request)

    def test_score_rejects_verifier_output_for_another_trial_or_source_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            request["verify"] = {"output": str(root / "verify-output")}
            expected = adapter.verification_expectation(request)
            result = {"sampleRef": request["trial"]["sampleRef"], "episodeId": "synthetic-trial.attempt",
                      "valid": True, "success": True, "issues": []}
            write_json(root / "solve-output/episode/native-result.json", result)
            write_json(root / "verify-output/verified.json", result)
            verification = {"sampleRef": result["sampleRef"], "episodeId": result["episodeId"],
                            "solveRunId": "source-run", "trialId": "synthetic-trial",
                            "implementationDigest": expected["verifierDigest"], "expectationDigest": digest(expected)}
            write_json(root / "verify-output/verification.json", verification)
            self.assertFalse(adapter.score(request)["invalid"])
            for key in ("solveRunId", "trialId", "expectationDigest"):
                write_json(root / "verify-output/verification.json", {**verification, key: "other"})
                with self.subTest(key=key):
                    self.assertTrue(adapter.score(request)["invalid"])

    def test_rescore_excludes_archived_robomme_simulator_errors(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            config = request["benchmark"]["config"]
            reference = json.loads(config["reference"])
            reference["environment"] = {"kind": "robomme", "tasks": [request["trial"]["task"]]}
            config.update(reference=json.dumps(reference), profileDigest=digest(reference))
            with patch.object(adapter, "settings", return_value=(root, config, reference)):
                self.assertEqual(adapter.tasks(request)["official"]["errors"], "fail")
            request["verify"] = {"output": str(root / "verify-output")}
            expected = adapter.verification_expectation(request)
            result = {"sampleRef": request["trial"]["sampleRef"], "episodeId": "synthetic-trial.attempt",
                      "valid": True, "success": False, "issues": [], "native": {"nativeStatus": "error"}}
            write_json(root / "solve-output/episode/native-result.json", result)
            write_json(root / "verify-output/verified.json", result)
            write_json(root / "verify-output/verification.json",
                       {"sampleRef": result["sampleRef"], "episodeId": result["episodeId"],
                        "solveRunId": expected["solveRunId"], "trialId": expected["executionTrialId"],
                        "implementationDigest": expected["verifierDigest"], "expectationDigest": digest(expected)})
            outcome = adapter.score(request)
            self.assertTrue(outcome["invalid"])
            self.assertEqual(outcome["failure"], "env_step")

    def test_calvin_reports_raw_completed_subtasks_as_its_primary_metric(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            config = request["benchmark"]["config"]
            reference = json.loads(config["reference"])
            reference["environment"] = {"kind": "calvin", "tasks": [request["trial"]["task"]],
                                        "catalog": {"sequences": [[0, ["one", "two", "three", "four", "five"]]]}}
            config.update(reference=json.dumps(reference), profileDigest=digest(reference))
            with patch.object(adapter, "settings", return_value=(root, config, reference)):
                catalog = adapter.tasks(request)
            self.assertEqual(catalog["official"]["metric"], "completed_subtasks")
            primary = [metric for metric in catalog["metrics"] if metric.get("primary")]
            self.assertEqual([(metric["name"], metric["range"]) for metric in primary],
                             [("completed_subtasks", [0, 5])])

            request["verify"] = {"output": str(root / "verify-output")}
            expected = adapter.verification_expectation(request)
            result = {"sampleRef": request["trial"]["sampleRef"], "episodeId": "synthetic-trial.attempt",
                      "valid": True, "success": False, "issues": [], "native": {"completedSubtasks": 2}}
            write_json(root / "solve-output/episode/native-result.json", result)
            write_json(root / "verify-output/verified.json", result)
            write_json(root / "verify-output/verification.json",
                       {"sampleRef": result["sampleRef"], "episodeId": result["episodeId"],
                        "solveRunId": expected["solveRunId"], "trialId": expected["trialId"],
                        "implementationDigest": expected["verifierDigest"], "expectationDigest": digest(expected)})
            outcome = adapter.score(request)
            self.assertFalse(outcome["invalid"])
            self.assertEqual(outcome["metrics"], {"completed_subtasks": 2, "success_at_1": 1, "success_at_2": 1,
                                                   "success_at_3": 0, "success_at_4": 0, "success_at_5": 0})

    def test_cliport_scores_partial_reward_as_a_scalar(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            config = request["benchmark"]["config"]
            reference = json.loads(config["reference"])
            reference["environment"] = {"kind": "cliport", "tasks": [request["trial"]["task"]]}
            config.update(reference=json.dumps(reference), profileDigest=digest(reference), renderer="pybullet-direct")
            with patch.object(adapter, "settings", return_value=(root, config, reference)):
                catalog = adapter.tasks(request)
            self.assertEqual(catalog["capabilities"]["scoreKind"], "scalar")

            request["verify"] = {"output": str(root / "verify-output")}
            expected = adapter.verification_expectation(request)
            result = {"sampleRef": request["trial"]["sampleRef"], "episodeId": "synthetic-trial.attempt",
                      "valid": True, "success": False, "issues": [], "native": {"totalReward": 0.5}}
            write_json(root / "solve-output/episode/native-result.json", result)
            write_json(root / "verify-output/verified.json", result)
            write_json(root / "verify-output/verification.json",
                       {"sampleRef": result["sampleRef"], "episodeId": result["episodeId"],
                        "solveRunId": expected["solveRunId"], "trialId": expected["trialId"],
                        "implementationDigest": expected["verifierDigest"], "expectationDigest": digest(expected)})
            outcome = adapter.score(request)
            self.assertFalse(outcome["invalid"])
            self.assertEqual(outcome["score"], 0.5)
            self.assertEqual(outcome["metrics"], {"success_rate": 0})

    def test_arena_reports_success_and_safety_cost_by_level(self):
        for suite, level, gate, success in (
            ("safety_hazard_avoidance", 0, True, False),
            ("safety_hazard_avoidance", 1, False, True),
            ("long_horizon", 2, False, True),
        ):
            with self.subTest(suite=suite, level=level, gate=gate), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                request = self.request(root)
                request["benchmark"]["path"] = str(root)
                request["verify"] = {"output": str(root / "verify-output")}
                config = request["benchmark"]["config"]
                reference = json.loads(config["reference"])
                reference["reference"]["files"] = {}
                task = request["trial"]["task"]
                levels = {task if difficulty == level else f"task-l{difficulty}": {"level": difficulty}
                          for difficulty in range(3)}
                reference["environment"] = {"kind": "vla-arena", "suite": suite, "safety": gate,
                                            "tasks": list(levels), "catalog": levels}
                config.update(reference=json.dumps(reference), profileDigest=digest(reference))

                safety_suite = suite.startswith("safety_")
                declared = [f"success_l{difficulty}" for difficulty in range(3)]
                if safety_suite:
                    declared.extend(["safety_cost", *(f"safety_cost_l{difficulty}" for difficulty in range(3))])
                metrics = adapter.tasks(request)["metrics"]
                self.assertEqual([metric["name"] for metric in metrics], declared)
                self.assertTrue(all(metric["higherIsBetter"] is False for metric in metrics[3:]))

                expected = adapter.verification_expectation(request)
                result = {"sampleRef": request["trial"]["sampleRef"], "episodeId": "synthetic-trial.attempt",
                          "valid": True, "success": success, "issues": [],
                          "native": {"taskSuccess": True, "safetyCost": 12.5}}
                write_json(root / "solve-output/episode/native-result.json", result)
                write_json(root / "verify-output/verified.json", result)
                write_json(root / "verify-output/verification.json",
                           {"sampleRef": result["sampleRef"], "episodeId": result["episodeId"],
                            "solveRunId": expected["solveRunId"], "trialId": expected["trialId"],
                            "implementationDigest": expected["verifierDigest"], "expectationDigest": digest(expected)})
                outcome = adapter.score(request)
                self.assertFalse(outcome["invalid"])
                self.assertEqual(outcome["score"], int(success))
                expected_metrics = {f"success_l{level}": int(success)}
                if safety_suite:
                    expected_metrics.update({"safety_cost": 12.5, f"safety_cost_l{level}": 12.5})
                self.assertEqual(outcome["metrics"], expected_metrics)

    def test_native_registration_help_requires_only_the_standard_library(self):
        for script in ("colosseum-v2/configure_colosseum.py", "libero-pro/configure_libero_pro.py"):
            with self.subTest(script=script):
                completed = subprocess.run([sys.executable, "-S", "-B", str(ADAPTER.parent / "benchmarks" / script), "--help"],
                                           text=True, capture_output=True)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertIn("--benchmark-image", completed.stdout)

    def test_host_verifier_planning_requires_only_the_standard_library(self):
        with tempfile.TemporaryDirectory() as temporary:
            request = {**self.request(Path(temporary)), "protocol": 1, "op": "verify"}
            completed = subprocess.run([sys.executable, "-S", "-B", str(ADAPTER), "verify"],
                                       input=json.dumps(request), text=True, capture_output=True)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(json.loads(completed.stdout)["spec"]["resources"]["gpus"], 0)

    def test_default_reference_agrees_across_phases_and_rejects_profile_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            request["benchmark"]["path"] = str(root)
            reference = json.loads(request["benchmark"]["config"].pop("reference"))
            reference["reference"]["files"] = {}
            here = root / "synthetic-adapter"
            here.mkdir()
            for name in ("run.py", "adapter.py"):
                shutil.copy2(ADAPTER.parent / name, here / name)
            write_json(here / "reference.json", reference)
            config = request["benchmark"]["config"]
            config["profileDigest"] = digest(reference)
            with patch.object(adapter, "HERE", here), patch.object(adapter, "catalog", return_value=[]):
                config["implementationDigest"] = adapter.implementation_digest()
                adapter.tasks(request)
                adapter.solve(request)
                adapter.verify(request)
                solve = json.loads((root / "staging/request.json").read_text())
                verify = json.loads((root / "staging/verify-request.json").read_text())
                self.assertEqual(solve["reference"], reference)
                self.assertEqual(verify["reference"], reference)
                changed = copy.deepcopy(reference)
                changed["parameters"]["settleSteps"] += 1
                write_json(here / "reference.json", changed)
                for phase in (adapter.tasks, adapter.solve, adapter.verify):
                    with self.subTest(phase=phase.__name__), self.assertRaisesRegex(ValueError, "profileDigest"):
                        phase(request)
                config["reference"] = json.dumps(reference)
                adapter.verify(request)


if __name__ == "__main__":
    unittest.main()
