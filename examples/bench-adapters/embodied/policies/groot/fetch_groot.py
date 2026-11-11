"""Fetch pinned inference assets; mirrors must match NVIDIA's public content identities."""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import sys
import urllib.parse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from model_assets import fetch, read_json


METADATA = {"config.json", "embodiment_id.json", "model.safetensors.index.json", "processor_config.json",
            "statistics.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json",
            "video_preprocessor_config.json", "vocab.json", "merges.txt", "chat_template.json", "generation_config.json"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--source", choices=("huggingface", "modelscope"), default="huggingface")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--direct-download", action="store_true", help="Bypass proxy environment variables for asset transfers only")
    parser.add_argument("--models", nargs="+", help="Select model entries such as fractal backbone; default: all")
    args = parser.parse_args()
    if not 1 <= args.workers <= 16:
        parser.error("workers must be between 1 and 16")
    reference = json.loads((Path(__file__).resolve().parents[2] / "profiles/groot-model.json").read_text())
    selected = set(args.models or reference["models"])
    if selected - set(reference["models"]):
        parser.error("unknown model entries: " + ", ".join(sorted(selected - set(reference["models"]))))
    jobs = []
    for target, model in reference["models"].items():
        if target not in selected:
            continue
        repository, revision, prefix = model["repository"], model["revision"], model["prefix"]
        metadata = read_json("https://huggingface.co/api/models/" + repository + "/revision/" + revision + "?blobs=true")
        if metadata["sha"] != revision:
            raise ValueError("Hub metadata differs from the pinned model revision: " + repository)
        destination = args.output_dir / target
        if target == "backbone":
            cache = args.output_dir / "hub" / ("models--" + repository.replace("/", "--"))
            destination = cache / "snapshots" / revision
            (cache / "refs").mkdir(parents=True, exist_ok=True)
            (cache / "refs/main").write_text(revision)
        mirror_files = {}
        if args.source == "modelscope":
            mirror_repository = "nv-community/" + repository.split("/", 1)[1]
            mirror_root = "https://modelscope.cn/api/v1/models/" + mirror_repository
            mirror_files = {file["Path"]: file for file in read_json(mirror_root + "/repo/files?Revision=master&Recursive=true")["Data"]["Files"]}
        for file in metadata["siblings"]:
            path = file["rfilename"]
            leaf = path[len(prefix):]
            if not path.startswith(prefix) or "/" in leaf or not (leaf in METADATA or leaf.endswith(".safetensors")):
                continue
            mirror = mirror_files.get(path)
            if args.source == "modelscope":
                if mirror is None or mirror["Size"] != file["size"]:
                    raise ValueError("mirror is missing the pinned asset: " + path)
                if "lfs" in file and file["lfs"]["sha256"] != mirror["Sha256"]:
                    raise ValueError("mirror weights differ from the pinned NVIDIA revision")
                url = mirror_root + "/repo?" + urllib.parse.urlencode({"Revision": mirror["Revision"], "FilePath": path})
            else:
                url = "https://huggingface.co/" + repository + "/resolve/" + revision + "/" + urllib.parse.quote(path)
            jobs.append((repository, revision, file, destination / leaf, url, mirror))
    print("Selected inference assets: " + str(round(sum(job[2]["size"] for job in jobs) / 1e9, 2)) + " GB", flush=True)
    rows = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for result in as_completed([pool.submit(fetch, job, direct=args.direct_download) for job in jobs]):
            rows.append(result.result())
    manifest = args.output_dir / "asset-manifest.json"
    previous = json.loads(manifest.read_text()) if manifest.exists() else []
    merged = {(row["repository"], row["revision"], row["path"]): row for row in previous + rows}
    manifest.write_text(json.dumps([merged[key] for key in sorted(merged)], indent=2) + "\n")


if __name__ == "__main__":
    main()
