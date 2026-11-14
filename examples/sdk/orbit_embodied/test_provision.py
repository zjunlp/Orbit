"""Pinned asset checksum and resume behavior with synthetic responses."""

import hashlib
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import sys
import unittest
import urllib.request
from unittest.mock import patch


ADAPTER = Path(__file__).resolve().parents[2] / "bench-adapters/embodied"
SPEC = importlib.util.spec_from_file_location("fetch_groot", ADAPTER / "policies/groot/fetch_groot.py")
fetcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fetcher)


def configured_resources(root, *, shared, profile="widowx", simulator_memory=None, suite="libero_spatial"):
    """Synthetic assets and audit/image identities; exercise production configuration and planning."""
    adapter_spec = importlib.util.spec_from_file_location("resource_fixture_adapter", ADAPTER / "adapter.py")
    adapter = importlib.util.module_from_spec(adapter_spec)
    adapter_spec.loader.exec_module(adapter)
    config_spec = importlib.util.spec_from_file_location("resource_fixture_config", Path(SPEC.origin).with_name("configure_groot.py"))
    config = importlib.util.module_from_spec(config_spec)
    with patch.dict(sys.modules, {"adapter": adapter}):
        config_spec.loader.exec_module(config)
    source, benchmark_source = root / "source", root / "benchmark"
    weights, output = root / "weights", root / "registrations"
    checkpoint = weights / {"libero": suite, "widowx": "bridge", "google": "fractal"}[profile]
    checkpoint.mkdir(parents=True)
    (checkpoint / "model.safetensors.index.json").write_text(json.dumps({"weight_map": {"synthetic": "model.safetensors"}}))
    (checkpoint / "model.safetensors").write_bytes(b"explicit synthetic checkpoint")
    (checkpoint / "statistics.json").write_text("{}")
    (weights / "hub").mkdir()
    (weights / "hub/backbone").write_bytes(b"explicit synthetic backbone")
    reference = json.loads((adapter.HERE / ("reference.json" if profile == "libero" else "profiles/groot-" + profile + ".json")).read_text())
    model = json.loads((adapter.HERE / "profiles/groot-model.json").read_text())
    audit = {(source / name).resolve(): expected for name, expected in model["files"].items()}
    audit.update({((benchmark_source if profile == "libero" else source) / name).resolve(): expected
                  for name, expected in reference["reference"]["files"].items()})
    original_digest = config.file_digest
    argv = ["configure_groot.py", "--reference-source", str(source), "--weights", str(weights), "--profile", profile,
            "--policy-image", "synthetic", "--benchmark-image", "synthetic", "--output-dir", str(output)]
    if profile == "libero":
        argv.extend(["--benchmark-source", str(benchmark_source), "--suite", suite])
    if shared:
        argv.append("--share-gpu")
    if simulator_memory is not None:
        argv.extend(["--sim-gpu-mem-gb", str(simulator_memory)])
    with patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()), \
            patch.object(config, "image_id", return_value="sha256:" + "a" * 64), \
            patch.object(config, "require_image", return_value="sha256:" + "b" * 64), \
            patch.object(config, "check_source") as check_source, \
            patch.object(config, "file_digest", side_effect=lambda path: audit[Path(path).resolve()] if Path(path).resolve() in audit else original_digest(path)):
        config.main()
        check_source.assert_called_once_with(source, model, model["files"])
    benchmark = json.loads((output / "benchmark.json").read_text())
    policy = json.loads((output / "policy.json").read_text())
    from orbit_embodied import digest, resolve_binding
    task = suite + ":synthetic" if profile == "libero" else reference["environment"]["tasks"][0]
    content = {"taskId": task, "benchmarkProfile": reference["id"], "initialStateId": "0",
               "initialStateDigest": "sha256:" + "a" * 64, "environmentSeed": 7, "policySeed": 0, "repetition": 0}
    sample = {**content, "sampleId": digest(content)}
    request = {"benchmark": benchmark, "trial": {"id": "synthetic", "sample": sample, "sampleRef": sample["sampleId"],
        "method": {"policySnapshot": policy}, "staging": str(root / "staging"),
        "binding": resolve_binding(reference["benchmarkProfile"], policy["profile"], reference["observationMap"])}}
    with patch.object(adapter, "settings", return_value=(source, benchmark["config"], reference)):
        spec = adapter.solve(request)["spec"]
    return {"policy": policy, "benchmark": benchmark, "spec": spec}


class Response(io.BytesIO):
    status = 206
    headers = {"Content-Range": "bytes 3-5/6"}


class ProvisionTests(unittest.TestCase):
    def test_selected_model_fetch_preserves_other_asset_identities_and_skips_training_files(self):
        reference = json.loads((ADAPTER / "profiles/groot-model.json").read_text())
        model = reference["models"]["fractal"]
        names = ["config.json", "statistics.json", "model.safetensors", "optimizer.pt", "training/model.safetensors"]
        metadata = {"sha": model["revision"], "siblings": [{"rfilename": name, "size": 1} for name in names]}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            previous = {"repository": "synthetic/previous", "revision": "prior", "path": "model.safetensors", "sha256": "unchanged"}
            (root / "asset-manifest.json").write_text(json.dumps([previous]))
            def fetched(job, **_kwargs):
                return {"repository": job[0], "revision": job[1], "path": job[2]["rfilename"], "sha256": "synthetic"}
            argv = ["fetch_groot.py", "--output-dir", str(root), "--models", "fractal"]
            with patch.object(sys, "argv", argv), patch.object(fetcher, "read_json", return_value=metadata) as read, \
                    patch.object(fetcher, "fetch", side_effect=fetched) as fetch, contextlib.redirect_stdout(io.StringIO()):
                fetcher.main()
            self.assertEqual(read.call_count, 1)
            self.assertIn(model["revision"], read.call_args[0][0])
            self.assertEqual({call.args[0][2]["rfilename"] for call in fetch.call_args_list}, set(names[:3]))
            self.assertTrue(all(call.args[0][3].parent == root / "fractal" for call in fetch.call_args_list))
            manifest = json.loads((root / "asset-manifest.json").read_text())
            self.assertIn(previous, manifest)
            self.assertEqual(len(manifest), 4)

    def test_generated_gpu_budgets_survive_both_sharing_modes_and_benchmarks(self):
        for profile in ("widowx", "libero", "google"):
            for shared in (False, True):
                with self.subTest(profile=profile, shared=shared), tempfile.TemporaryDirectory() as temporary:
                    configured = configured_resources(Path(temporary), shared=shared, profile=profile)
                    service, resources = configured["policy"]["service"], configured["spec"]["resources"]
                    self.assertEqual(service["gpuMemGB"], 24)
                    gpu_simulator = shared or profile != "libero"
                    self.assertEqual(resources["gpus"], int(gpu_simulator))
                    self.assertEqual(resources.get("gpuMemGB"), 4 if gpu_simulator else None)
                    self.assertEqual(service.get("gpusOf"), "main" if shared else None)

    def test_simulator_budget_can_be_configured_without_changing_the_policy(self):
        with tempfile.TemporaryDirectory() as temporary:
            configured = configured_resources(Path(temporary), shared=True, simulator_memory=8)
            self.assertEqual(configured["spec"]["resources"]["gpuMemGB"], 8)
            self.assertEqual(configured["policy"]["service"]["gpuMemGB"], 24)

    def test_invalid_simulator_budgets_are_rejected(self):
        for memory in (0, -1, float("nan"), float("inf")):
            with self.subTest(memory=memory), tempfile.TemporaryDirectory() as temporary, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as caught:
                    configured_resources(Path(temporary), shared=True, simulator_memory=memory)
                self.assertEqual(caught.exception.code, 2)

    def job(self, destination):
        content = b"abcdef"
        sha = hashlib.sha256(content).hexdigest()
        blob = hashlib.sha1(b"blob 6\0" + content).hexdigest()
        return ("synthetic/model", "pinned", {"rfilename": "model.safetensors", "size": 6,
            "lfs": {"sha256": sha}, "blobId": blob}, destination, "https://example.invalid/asset", {"Sha256": sha})

    def test_resumes_partial_and_rejects_corrupted_existing_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "model"
            path.with_name("model.partial").write_bytes(b"abc")
            with patch.object(urllib.request.OpenerDirector, "open", return_value=Response(b"def")) as request:
                result = fetcher.fetch(self.job(path))
            self.assertEqual(request.call_args[0][0].get_header("Range"), "bytes=3-")
            self.assertEqual(path.read_bytes(), b"abcdef")
            self.assertEqual(result["bytes"], 6)
            path.write_bytes(b"corrupt")
            with self.assertRaisesRegex(ValueError, "size mismatch"):
                fetcher.fetch(self.job(path))

    def test_complete_partial_is_verified_without_redownloading(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "model"
            path.with_name("model.partial").write_bytes(b"abcdef")
            with patch.object(urllib.request.OpenerDirector, "open") as request:
                fetcher.fetch(self.job(path))
            request.assert_not_called()
            self.assertEqual(path.read_bytes(), b"abcdef")

    def test_wrong_same_size_content_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "model"
            path.write_bytes(b"ABCDEF")
            with self.assertRaisesRegex(ValueError, "differs from pinned upstream"):
                fetcher.fetch(self.job(path))

    def test_offline_resolution_only_changes_runtime_metadata_and_keeps_assets_read_only(self):
        spec = importlib.util.spec_from_file_location("serve_groot", Path(SPEC.origin).with_name("serve_groot.py"))
        server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(server)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checkpoint, destination, cache = root / "checkpoint", root / "runtime", root / "hub"
            checkpoint.mkdir()
            destination.mkdir()
            cached = cache / "models--nvidia--Cosmos-Reason2-2B"
            (cached / "refs").mkdir(parents=True)
            (cached / "refs/main").write_text("a" * 40)
            snapshot = cached / "snapshots" / ("a" * 40)
            snapshot.mkdir(parents=True)
            original = {"model_name": "nvidia/Cosmos-Reason2-2B", "other": 123}
            (checkpoint / "config.json").write_text(json.dumps(original))
            (checkpoint / "processor_config.json").write_text(json.dumps({"processor_kwargs": {"other": 456}}))
            (checkpoint / "model.safetensors").write_bytes(b"synthetic weights")
            server.prepare_checkpoint(checkpoint, cache, destination)
            self.assertEqual(json.loads((checkpoint / "config.json").read_text()), original)
            alias = destination / "nvidia/Cosmos-Reason2-2B"
            self.assertEqual(alias.resolve(), snapshot)
            self.assertEqual(json.loads((destination / "config.json").read_text()), {**original, "model_name": str(alias)})
            self.assertEqual((destination / "model.safetensors").resolve(), checkpoint / "model.safetensors")


if __name__ == "__main__":
    unittest.main()
