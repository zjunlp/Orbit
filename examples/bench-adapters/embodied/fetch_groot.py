"""Fetch pinned inference assets; mirrors must match NVIDIA's public content identities."""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.parse
import urllib.request


METADATA = {"config.json", "embodiment_id.json", "model.safetensors.index.json", "processor_config.json",
            "statistics.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json",
            "video_preprocessor_config.json", "vocab.json", "merges.txt", "chat_template.json", "generation_config.json"}


def read_json(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response)


def hashes(path, size):
    sha = hashlib.sha256()
    blob = hashlib.sha1(("blob " + str(size) + "\0").encode())
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            sha.update(block)
            blob.update(block)
    return sha.hexdigest(), blob.hexdigest()


def fetch(job, *, direct=False):
    repository, revision, file, destination, url, mirror = job
    size = file["size"]
    def verify(path):
        if path.stat().st_size != size:
            raise ValueError("asset size mismatch: " + file["rfilename"])
        sha, blob = hashes(path, size)
        if (sha != file["lfs"]["sha256"] if "lfs" in file else blob != file["blobId"]):
            raise ValueError("asset differs from pinned upstream content: " + file["rfilename"])
        if mirror is not None and sha != mirror["Sha256"]:
            raise ValueError("mirror checksum mismatch")
        return sha
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        partial = destination.with_name(destination.name + ".partial")
        for attempt in range(4):
            try:
                offset = partial.stat().st_size if partial.exists() else 0
                if offset == size:
                    verify(partial)
                    partial.replace(destination)
                    break
                if offset > size:
                    raise ValueError("partial asset exceeds expected size: " + file["rfilename"])
                headers = {"Range": "bytes=" + str(offset) + "-"} if offset else {}
                if url.startswith("https://huggingface.co/") and os.environ.get("HF_TOKEN"):
                    headers["Authorization"] = "Bearer " + os.environ["HF_TOKEN"]
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({})) if direct else urllib.request.build_opener()
                with opener.open(urllib.request.Request(url, headers=headers), timeout=120) as response:
                    append = offset > 0 and response.status == 206
                    if append and response.headers.get("Content-Range", "").split("/", 1)[0] != "bytes " + str(offset) + "-" + str(size - 1):
                        raise ValueError("download resume returned an unexpected byte range")
                    with partial.open("ab" if append else "wb") as stream:
                        for block in iter(lambda: response.read(8 * 1024 * 1024), b""):
                            stream.write(block)
                verify(partial)
                partial.replace(destination)
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2)
    checksum = verify(destination)
    print("Verified " + repository + "/" + file["rfilename"], flush=True)
    return {"repository": repository, "revision": revision, "path": file["rfilename"],
            "bytes": size, "sha256": checksum, "officialBlob": file["blobId"]}


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
    reference = json.loads((Path(__file__).parent / "profiles/groot-model.json").read_text())
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
