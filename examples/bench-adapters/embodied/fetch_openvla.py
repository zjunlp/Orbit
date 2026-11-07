"""Download merged OFT inference assets, checking the pinned public Hub hashes."""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import urllib.parse

from fetch_groot import fetch, read_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--model", choices=("spatial", "combined"), default="spatial")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    if not 1 <= args.workers <= 16:
        parser.error("workers must be between 1 and 16")
    reference = json.loads((Path(__file__).parent / "profiles/openvla-model.json").read_text())
    selected = reference["models"][args.model]
    repository, revision = selected["repository"], selected["revision"]
    metadata = read_json("https://huggingface.co/api/models/" + repository + "/revision/" + revision + "?blobs=true")
    if metadata["sha"] != revision:
        raise ValueError("Hub metadata differs from the pinned model revision")
    jobs = []
    for file in metadata["siblings"]:
        name = file["rfilename"]
        if "/" in name or name in (".gitattributes", "README.md"):
            continue
        url = "https://huggingface.co/" + repository + "/resolve/" + revision + "/" + urllib.parse.quote(name)
        jobs.append((repository, revision, file, args.output_dir / name, url, None))
    print("Selected merged inference assets: " + str(round(sum(job[2]["size"] for job in jobs) / 1e9, 2)) + " GB", flush=True)
    rows = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for result in as_completed([pool.submit(fetch, job) for job in jobs]):
            rows.append(result.result())
    (args.output_dir / "asset-manifest.json").write_text(json.dumps(sorted(rows, key=lambda row: row["path"]), indent=2) + "\n")


if __name__ == "__main__":
    main()
