"""Build or register the published RoboMME no-history pi0.5 baseline."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from native_runtime import configure_action_policy
import serve_robomme_pi05


SOURCE = {"repository": "https://github.com/RoboMME/robomme_policy_learning",
          "commit": "ac846a9a4aec841e483b1dc5d620dfe426bde853"}


if __name__ == "__main__":
    configure_action_policy("robomme-pi05-baseline", SOURCE, ("src", "packages/openpi-client"),
                            serve_robomme_pi05, "robomme-panda-joint-angle/1", 16, 24,
                            interpreter="/.venv/bin/python")
