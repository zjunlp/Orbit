"""Populate a read-only MolmoSpaces asset bundle from the pinned upstream archives."""

import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ET

from molmospaces_resources import GCRemoteStorage, R2RemoteStorage, setup_resource_manager


SCENE_OBJECT_MANIFEST = "orbit-scene-objects.json"


def hardlink(source, destination):
    return os.link(Path(source).resolve(strict=True), destination)


def scene_object_paths(links):
    """Collect the shared meshes and textures needed by the installed scene XMLs."""
    for scene in (links / "scenes").glob("*/*.xml"):
        for element in ET.parse(scene).iter():
            parts = Path(element.get("file", "")).parts
            if len(parts) >= 6 and parts[:4] == ("..", "..", "objects", "objaverse"):
                yield Path(*parts[2:])


def prepare(root, versions, catalogs):
    assets = root / "assets"
    if assets.exists():
        raise FileExistsError("MolmoSpaces asset bundle already exists")
    with tempfile.TemporaryDirectory(prefix=".molmospaces-", dir=root) as temporary:
        work = Path(temporary)
        links = work / "links"
        links.mkdir()
        if "procthor-objaverse-val" in versions["scenes"]:
            remote = GCRemoteStorage("molmospaces-mujoco")
        else:
            remote = R2RemoteStorage("mujoco-thor-resources")
        manager = setup_resource_manager(remote, links, versions, root / "cache", cache_lock=True)
        scenes = {}
        added_objects = set()
        for catalog in catalogs:
            for episode in json.loads((links / catalog).read_text()):
                source = episode["scene_dataset"]
                if source != "ithor":
                    source += "-" + episode["data_split"]
                scenes.setdefault(source, set()).add(episode["house_index"])
                added_objects.update(Path(value) for value in episode["scene_modifications"]["added_objects"].values())

        packages = {}
        for source, indices in scenes.items():
            archives = set(manager.unindexed_archives("scenes", source))
            for index in sorted(indices):
                found = manager.index_lookup("scenes", source, str(index))
                if len(found) != 1:
                    raise ValueError(f"expected one archive for MolmoSpaces {source} scene {index}")
                archives.update(found)
            packages[source] = sorted(archives)
        manager.install_packages("scenes", packages)
        manager.install_all_for_source("scenes", "refs")
        scene_objects = set(scene_object_paths(links))
        # The meshes and textures for one object are packaged with its root MJCF.
        object_files = {path.relative_to("objects/objaverse") for path in added_objects
                        if path.parts[:2] == ("objects", "objaverse")}
        object_files.update(Path(path.parts[2], f"{path.parts[2]}.xml") for path in scene_objects)
        objaverse = sorted(object_files)
        if objaverse:
            archives = manager.find_archives("objects", "objaverse", objaverse)
            manager.install_packages("objects", {"objaverse": archives})
        for path in sorted(added_objects | scene_objects):
            if not (links / path).is_file():
                raise ValueError(f"MolmoSpaces asset bundle lacks the referenced object asset {path}")

        materialized = work / "materialized"
        shutil.copytree(links, materialized, ignore=shutil.ignore_patterns(".lmdb", "*.lock"),
                        copy_function=hardlink)
        if scene_objects:
            (materialized / SCENE_OBJECT_MANIFEST).write_text(
                json.dumps(sorted(path.as_posix() for path in scene_objects)) + "\n")
        materialized.rename(assets)


if __name__ == "__main__":
    prepare(Path("/molmospaces"), json.loads(sys.argv[1]), json.loads(sys.argv[2]))
