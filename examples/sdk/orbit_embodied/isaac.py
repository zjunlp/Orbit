"""Apply NVIDIA's documented Vulkan version-reporting workaround only to affected drivers."""

import re
import subprocess
import sys


DRIVER_ISSUE = "https://docs.omniverse.nvidia.com/dev-guide/latest/common/technical-requirements.html"


def driver_version_kit_args():
    if sys.platform != "linux":
        return ""
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
            check=True, capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError, UnicodeError) as exc:
        print(f"[Orbit Isaac] Driver query failed ({type(exc).__name__}); keeping native driver verification.", flush=True)
        return ""
    versions = [line.strip() for line in result.stdout.strip().splitlines()]
    if not versions or len(set(versions)) != 1:
        print("[Orbit Isaac] Driver query is empty or inconsistent; keeping native driver verification.", flush=True)
        return ""
    version = versions[0]
    match = re.fullmatch(r"([1-9][0-9]*)\.([0-9]+)(?:\.([0-9]+))?", version)
    if match is None:
        print("[Orbit Isaac] Driver query returned a malformed version; keeping native driver verification.", flush=True)
        return ""
    if int(match[1]) != 535 or int(match[2]) < 256:
        print(f"[Orbit Isaac] NVIDIA driver {version}; keeping native driver verification.", flush=True)
        return ""
    print(f"[Orbit Isaac] NVIDIA driver {version} confirmed by nvidia-smi. Applying NVIDIA's documented "
          f"Linux R535.256+ Vulkan version-reporting workaround: disable the misreporting RTX version gate "
          f"for this process; other renderer and device checks remain active. {DRIVER_ISSUE}", flush=True)
    return "--/rtx/verifyDriverVersion/enabled=false"
