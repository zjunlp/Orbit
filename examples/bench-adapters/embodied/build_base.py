"""Build an audited upstream dependency image using an existing standalone Python runtime."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference-source", type=Path, required=True)
    parser.add_argument("--component", choices=("benchmark", "policy"), required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--lerobot-source", type=Path)
    args = parser.parse_args()
    reference = json.loads((Path(__file__).parent / "reference.json").read_text())
    relative = "examples/libero/Dockerfile" if args.component == "benchmark" else "scripts/docker/serve_policy.Dockerfile"
    source = (args.reference_source / relative).read_text()
    checksum = "sha256:" + hashlib.sha256(source.encode()).hexdigest()
    if checksum != reference["reference"]["files"][relative]:
        raise ValueError("upstream Dockerfile differs from the audited reference")
    executable = args.python.resolve()
    version = subprocess.check_output([str(executable), "--version"], text=True).strip()
    expected = "3.8.20" if args.component == "benchmark" else "3.11.9"
    if version != "Python " + expected:
        raise ValueError("expected the reference runtime Python " + expected)
    runtime = executable.parent.parent
    if not (runtime / "lib").is_dir():
        raise ValueError("provide a standalone Python distribution, not a virtual environment copy")
    selector = "3.8" if args.component == "benchmark" else "3.11.9"
    original = "RUN uv venv --python " + selector + " $UV_PROJECT_ENVIRONMENT"
    replacement = "COPY --from=orbit-python / /opt/orbit-python/\nRUN uv venv --python /opt/orbit-python/bin/python" + selector.split(".")[0] + "." + selector.split(".")[1] + " $UV_PROJECT_ENVIRONMENT"
    if source.count(original) != 1:
        raise ValueError("upstream Python provisioning step changed")
    recipe = source.replace(original, replacement)
    if args.component == "benchmark":
        # The runtime lock already fixes setuptools 75.3.0. Use that version for sdist builds too:
        # unconstrained isolated builds can select a backend that no longer supports Python 3.8.
        command = "RUN uv pip sync "
        if recipe.count(command) != 1:
            raise ValueError("upstream dependency installation step changed")
        recipe = recipe.replace(command, "RUN uv pip install setuptools==75.3.0 wheel==0.45.1 packaging==24.2\nRUN uv pip sync --no-build-isolation ")
    with tempfile.TemporaryDirectory(prefix="orbit-embodied-build-") as temporary:
        contexts = ["--build-context", "orbit-python=" + str(runtime)]
        if args.component == "policy" and args.lerobot_source:
            pyproject = (args.reference_source / "pyproject.toml").read_text()
            if "sha256:" + hashlib.sha256(pyproject.encode()).hexdigest() != reference["reference"]["files"]["pyproject.toml"]:
                raise ValueError("model dependencies differ from the audited source")
            matched = re.search(r'lerobot = \{ git = "([^"]+)", rev = "([a-f0-9]{40})" \}', pyproject)
            if not matched:
                raise ValueError("locked LeRobot dependency was not found")
            repository, revision = matched.groups()
            bare = Path(temporary) / "lerobot.git"
            subprocess.run(["git", "init", "--bare", str(bare)], check=True)
            subprocess.run(["git", "-C", str(bare), "fetch", "--no-tags", str(args.lerobot_source.resolve()), revision], check=True)
            subprocess.run(["git", "-C", str(bare), "update-ref", "refs/heads/orbit-reference", revision], check=True)
            (bare / "FETCH_HEAD").unlink(missing_ok=True)
            setup = ("COPY --from=orbit-git / /opt/orbit-git/lerobot.git/\n"
                     "RUN git config --global protocol.file.allow always && git config --global "
                     "url.file:///opt/orbit-git/lerobot.git.insteadOf " + repository + "\n")
            marker = "RUN --mount=type=cache,target=/root/.cache/uv"
            if recipe.count(marker) != 1:
                raise ValueError("upstream model dependency installation step changed")
            recipe = recipe.replace(marker, setup + marker, 1)
            contexts += ["--build-context", "orbit-git=" + str(bare)]
        recipe_digest = "sha256:" + hashlib.sha256(recipe.encode()).hexdigest()
        recipe += "\nLABEL orbit.reference.openpi=" + reference["reference"]["openpi"]["commit"]
        recipe += "\nLABEL orbit.reference.python=" + expected
        recipe += "\nLABEL orbit.reference.source-dockerfile=" + checksum
        recipe += "\nLABEL orbit.reference.build-recipe=" + recipe_digest + "\n"
        dockerfile = Path(temporary) / "Dockerfile"
        dockerfile.write_text(recipe)
        subprocess.run(["docker", "build", "--label", "orbit.task=embodied-eval", "--progress=plain",
                        *contexts, "-t", args.tag,
                        "-f", str(dockerfile), str(args.reference_source)], check=True)


if __name__ == "__main__":
    main()
