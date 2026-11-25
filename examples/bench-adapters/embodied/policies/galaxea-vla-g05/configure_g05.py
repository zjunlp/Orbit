"""Build or register the LeRobot G0.5 RoboTwin policy."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from native_runtime import configure_action_policy
import serve_g05


SOURCE = {"repository": "https://github.com/huggingface/lerobot",
          "commit": "410c095eacc0011d998a73383eb94abed2715af0"}

# Consumed assets from lerobot/g05_robotwin20 at b3b9695ce1f6dd08b4fb96486597fd2eb5c63ab0.
RELEASE_ASSETS = {
    "checkpointDigest": "sha256:3a92641b3c126b49a750da421f0dba80fe7a081733b8ab3316eb35e6fbf42542",
    "backboneDigest": "sha256:79d29ef2414584c12076542e7f682a06746caf2bdb95fc4a9156530c56625928",
    "normalizationDigest": "sha256:2bff7eea5499dec6f1c81118c72919cb50ed97996f71989684b61d5203401112",
}


if __name__ == "__main__":
    configure_action_policy("galaxea-vla-g05-robotwin", SOURCE, ("src/lerobot/policies/g05",),
                            serve_g05, "robotwin-aloha-agilex-native/1", serve_g05.REPLAN_STEPS, 16,
                            release_assets=RELEASE_ASSETS)
