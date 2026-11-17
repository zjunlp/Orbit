"""Build or register the pinned Motus RoboTwin policy."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from native_runtime import configure_action_policy
import serve_motus


SOURCE = {"repository": "https://github.com/thu-ml/Motus", "commit": "88f6fe30c62af033874b0a2e48ad1cbdaf12cfdf"}


if __name__ == "__main__":
    configure_action_policy("motus-robotwin", SOURCE, ("inference/robotwin/Motus",),
                            serve_motus, "robotwin-aloha-agilex-native/1", 16, 44,
                            normalization_source=serve_motus.NORMALIZATION, flash_attention=True)
