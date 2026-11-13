"""Build the model image from clean, pinned official source checkouts."""

import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--openvla-source", type=Path, required=True)
    parser.add_argument("--transformers-source", type=Path, required=True)
    parser.add_argument("--dlimp-source", type=Path, required=True)
    parser.add_argument("--tag", required=True)
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    reference = json.loads((here.parents[1] / "profiles/openvla-model.json").read_text())
    contexts = []
    for name, pin in reference["sources"].items():
        path = getattr(args, name + "_source").resolve()
        revision = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
        dirty = subprocess.check_output(["git", "-C", str(path), "status", "--porcelain", "--untracked-files=normal"], text=True).strip()
        if revision != pin["commit"] or dirty:
            raise ValueError("expected a clean pinned source checkout: " + name)
        contexts += ["--build-context", name + "=" + str(path)]
    subprocess.run(["docker", "build", "--label", "orbit.task=embodied-eval", "--progress=plain", *contexts,
                    "-t", args.tag, "-f", str(here / "openvla-policy.Dockerfile"), str(here.parents[4])], check=True)


if __name__ == "__main__":
    main()
