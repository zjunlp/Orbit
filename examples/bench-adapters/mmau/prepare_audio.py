"""Extract official test-mini WAVs from the pinned HF Parquet, inside an Orbit run."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re

PARQUET_SHA256 = "54b76f440db843546f9ad49a1518cc22371f63a266f034ba6bd4343b7b6fde86"
ANNOTATIONS_BLOB = "a2f7539b406a7a466d554e15a22342dbfe53c461"


def extract(parquet, annotations, output, ids=None):
    import pyarrow.parquet as pq

    digest = hashlib.sha256()
    with Path(parquet).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != PARQUET_SHA256:
        raise ValueError("Parquet differs from the pinned official HF release")
    raw = Path(annotations).read_bytes()
    if hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest() != ANNOTATIONS_BLOB:
        raise ValueError("Annotations differ from the pinned GitHub release")
    original = {r["id"]: r for r in json.loads(raw)}
    selected = set(original) if not ids else set(ids)
    if not selected.issubset(original):
        raise ValueError("Unknown question IDs")
    output = Path(output)
    manifest = {}
    for batch in pq.ParquetFile(parquet).iter_batches(batch_size=1):
        row = batch.to_pylist()[0]
        attributes = json.loads(row["other_attributes"])
        name = attributes["id"]
        if name not in selected:
            continue
        native = original[name]
        unletter = lambda text: re.sub(r"^\([A-D]\) ", "", text)
        if (row["instruction"] != native["question"]
                or [unletter(c) for c in row["choices"]] != native["choices"]
                or unletter(row["answer"]) != native["answer"]
                or any(attributes[k] != native[k] for k in ("task", "split", "difficulty"))):
            raise ValueError(f"HF/GitHub annotation mismatch: {name}")
        data = row["context"]["bytes"]
        if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
            raise ValueError(f"Expected original WAV bytes: {name}")
        destination = (output / native["audio_id"]).resolve()
        if not destination.is_relative_to(output.resolve()):
            raise ValueError("Audio path escapes output")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        manifest[name] = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    if set(manifest) != selected:
        raise ValueError("Parquet did not contain every requested question")
    (output / "audio-manifest.json").write_text(json.dumps({
        "parquetSha256": PARQUET_SHA256, "annotationsBlob": ANNOTATIONS_BLOB, "clips": manifest}, indent=2))
    print(f"Extracted {len(manifest)} verified original WAVs", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--parquet", required=True)
    parser.add_argument("--annotations", required=True)
    parser.add_argument("--output", default=os.environ.get("ORBIT_OUTPUT"))
    parser.add_argument("--ids", nargs="+")
    args = parser.parse_args()
    if not args.output:
        parser.error("--output or ORBIT_OUTPUT is required")
    extract(args.parquet, args.annotations, args.output, args.ids)
