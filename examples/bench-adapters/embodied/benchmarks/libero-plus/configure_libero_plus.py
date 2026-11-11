"""Generate all four native LIBERO-Plus benchmark registrations."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE, check_source, digest, file_digest, implementation_digest
from native_runtime import image_id
from orbit_embodied.assets import tree_digest
from orbit_embodied.libero_plus import NATIVE_ROOT, SOURCE_FILES, SUITE_COUNTS, catalog
from orbit_embodied.libero_suites import LABELS


SOURCE = {"repository": "https://github.com/sylvestf/LIBERO-plus",
          "commit": "4976dc30028e805ff8094b55501d532c48fec182"}
DATASET = "libero-plus-assets"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--benchmark-image", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    root = args.source.resolve()
    files = {name: file_digest(root / name) for name in SOURCE_FILES}
    check_source(root, SOURCE, files)
    if any(not (args.assets / folder).is_dir() for folder in ("new_objects", "textures", "scenes")):
        parser.error("--assets must point to the extracted official assets directory")
    assets = {"dataset": DATASET, "target": NATIVE_ROOT + "/assets", "digest": tree_digest(args.assets)}
    image = image_id(args.benchmark_image)
    implementation = implementation_digest()
    for suite, total in SUITE_COUNTS.items():
        listing = catalog(root, suite)
        supported = sum(row["supported"] for row in listing)
        recipe = json.loads((HERE / "profiles/openvla-libero.json").read_text())
        label = LABELS[suite]
        reference = {
            "id": "libero-plus-" + label + "-native/1",
            "environment": {"kind": "libero-plus", "suite": suite, "assets": assets},
            "horizons": {suite: recipe["horizons"][suite]},
            "parameters": {**recipe["parameters"], "environmentSeed": 7},
            "reference": {"evaluation": SOURCE, "files": files,
                          "motionBlurPatch": file_digest(Path(__file__).resolve().with_name("prepare_libero_plus.py"))},
            "benchmarkProfile": {**recipe["benchmarkProfile"], "id": "libero-plus-panda-raw/1"},
            "policyProfile": recipe["policyProfile"],
            "observationMap": recipe["observationMap"],
            "scoreName": "LIBERO-Plus " + label.title() + " success",
        }
        name = "libero-plus-" + label + "-native"
        benchmark = {"name": name, "path": str(root), "adapter": str(HERE / "adapter.py"), "config": {
            "suite": suite, "image": image, "python": "/.venv/bin/python", "renderer": "egl",
            "simGpus": "1", "simGpuMemGB": "4", "reference": json.dumps(reference, separators=(",", ":")),
            "profileDigest": digest(reference), "implementationDigest": implementation,
        }}
        output = args.output_dir / label
        output.mkdir(parents=True, exist_ok=True)
        for filename, value in (("benchmark.json", benchmark), ("reference.json", reference)):
            (output / filename).write_text(json.dumps(value, indent=2) + "\n")
        print(f"{name}: {supported}/{total} variants with BDDL and initial state")


if __name__ == "__main__":
    main()
