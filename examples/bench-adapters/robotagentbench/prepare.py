"""Export an already restored native Runtime into the existing Orbit adapter protocol."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

from adapter import REVISION, catalog, native_reason, sha


def bindings(argv, image):
    """Read original namespace declarations without executing its Docker command."""
    binds, env = [], {}
    index = 2
    flags = {"--rm", "--interactive", "--read-only"}
    ignored = {"--name", "--network", "--user", "--cap-drop", "--security-opt",
               "--tmpfs", "--label", "--gpus", "--runtime"}
    while index < argv.index(image):
        flag = argv[index]
        index += 1
        if flag in flags:
            continue
        value = argv[index]
        index += 1
        if flag in ignored:
            continue
        if flag == "--env":
            key, value = value.split("=", 1)
            env[key] = value
        elif flag == "--mount":
            parts = value.split(",")
            row = dict(p.split("=", 1) for p in parts if "=" in p)
            if row.get("type") != "bind" or set(row) != {"type", "src", "dst"}:
                raise ValueError("Only original explicit bind mounts are accepted")
            if "docker.sock" in row["src"] or "docker.sock" in row["dst"]:
                raise ValueError("The native service never receives a Docker socket")
            binds.append({"source": row["src"], "target": row["dst"],
                          "mode": "ro" if "readonly" in parts else "rw"})
        else:
            raise ValueError("Unknown native namespace option: " + flag)
    return binds, env


def export(source, selected, native_image, name, locks):
    from robotagentbench import namespace
    from robotagentbench.model_examples import docker_workflow as workflow
    from robotagentbench.model_examples.relocation import aliases
    selected, row, base, native_source, _ = workflow.selection(selected)
    task, ordinal = row["task_id"], row["episode"]
    groups = catalog(source)
    matches = [group for group in groups if group.split("/")[1] == task]
    if len(matches) != 1 or ordinal not in groups[matches[0]]:
        raise ValueError("The restored receipt is not a released saved configuration")
    group = matches[0]
    if native_reason(group):
        raise ValueError(native_reason(group))
    if row.get("resampled") is not False or row.get("physics_scoring_modified") is not False:
        raise ValueError("Use the unchanged native saved-configuration restoration")
    argv = namespace.command(base, native_image, "run", name=name, gpu=0, locks=locks,
                             native_deployment=True)
    binds, env = bindings(argv, native_image)
    binds.append({"source": str(base), "target": str(base), "mode": "rw"})
    binds.append({"source": str(selected.parent), "target": str(selected.parent), "mode": "ro"})
    for alias in aliases(base, task, row.get("readonly_resource_aliases", [])):
        binds.append({**alias, "mode": "ro"})
    targets = [b["target"] for b in binds]
    if len(set(targets)) != len(targets):
        raise ValueError("Conflicting native mount aliases")
    launch = Path(row["launch"])
    command = ["/usr/local/bin/python3.11", "-B", "-u", "-m",
               "robotagentbench.model_examples.native_worker", "--runtime", str(base),
               "--sdk-site", "/opt/robotagentbench/native", "--launch", str(launch),
               "--output", "{output}", "--lock-root", "/locks", "--gpu", "0",
               "--input-root", str(native_source), "--execute"]
    if row.get("public_input_binding"):
        command += ["--public-input-binding", row["public_input_binding"]]
    # Validate every copied Runtime byte again before admission. Keys and model state
    # do not belong in this benchmark Runtime.
    files = {}
    for path in sorted(base.rglob("*")):
        if path.is_symlink():
            raise ValueError("Prepared Runtime must use canonical files, not symlinks")
        if path.is_file():
            files[str(path)] = sha(path)
    files[str(selected)] = sha(selected)
    return group, str(ordinal), {
        "runtime": str(base), "image": native_image, "nativeTask": task, "actualSeed": row["actual_seed"],
        "files": files, "binds": binds, "env": env, "command": command,
        "deployment": {"name": name, "image": native_image},
        "outputPrefix": str(workflow.output_root(native_source, json.loads(launch.read_text())))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--native-image", required=True)
    parser.add_argument("--agent-image", required=True)
    parser.add_argument("--deployment", required=True)
    parser.add_argument("--lock-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    if subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip() != REVISION:
        raise ValueError("Use the pinned RobotAgentBench source")
    subprocess.run(["git", "-C", str(source), "diff", "--quiet", "HEAD", "--"], check=True)
    sys.path.insert(0, str(source / "src"))
    from robotagentbench.simulation.native_deployment import image_id
    def image(value):
        return image_id(subprocess.check_output(
            ["docker", "image", "inspect", "--format", "{{.Id}}", value], text=True).strip())
    native_image, agent_image = image(args.native_image), image(args.agent_image)
    label = subprocess.check_output(["docker", "image", "inspect", "--format",
        '{{index .Config.Labels "org.orbit.robotagentbench.source"}}', native_image], text=True).strip()
    if label != REVISION:
        raise ValueError("Wrap the pinned native image before preparing its deployment")
    group, ordinal, entry = export(source, args.selection.resolve(strict=True), native_image,
                                   args.deployment, args.lock_root.resolve(strict=True))
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    manifest = output / "prepared.json"
    value = json.loads(manifest.read_text()) if manifest.exists() else {
        "version": 1, "revision": REVISION, "episodes": {},
        "sourceFiles": {p.relative_to(source / "src/robotagentbench").as_posix(): sha(p)
                        for p in sorted((source / "src/robotagentbench").rglob("*.py"))}}
    if value.get("revision") != REVISION:
        raise ValueError("Do not combine source revisions in a prepared manifest")
    if ordinal in value["episodes"].get(group, {}):
        raise ValueError("Do not overwrite an existing frozen saved configuration")
    value["episodes"].setdefault(group, {})[ordinal] = entry
    manifest.write_text(json.dumps(value, indent=2) + "\n")
    config = {"name": "robotagentbench-raw22", "path": str(source),
              "adapter": str(Path(__file__).parent / "adapter.py"),
              "resources": str(Path(__file__).parent / "resources.json"),
              "config": {"prepared": str(manifest), "image": agent_image}}
    (output / "benchmark.json").write_text(json.dumps(config, indent=2) + "\n")
    print("Prepared native saved configuration; no simulator or model was started.")


if __name__ == "__main__":
    main()
