"""Build or register the LeRobot G0.5 RoboTwin policy."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from native_runtime import configure_action_policy
import serve_g05


SOURCE = {"repository": "https://github.com/huggingface/lerobot",
          "commit": "410c095eacc0011d998a73383eb94abed2715af0"}


if __name__ == "__main__":
    configure_action_policy("galaxea-vla-g05-robotwin", SOURCE, ("src/lerobot/policies/g05",),
                            serve_g05, "robotwin-aloha-agilex-native/1", serve_g05.REPLAN_STEPS, 16)
