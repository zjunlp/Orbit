"""Build or register the pinned Hy-Embodied-0.5-VLA RoboTwin policy."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from native_runtime import configure_action_policy
import serve_hy_vla


SOURCE = {"repository": "https://github.com/Tencent-Hunyuan/Hy-Embodied-0.5-VLA",
          "commit": "af57e7507ec5964b52fdf6296741e553cbcd3288"}


if __name__ == "__main__":
    configure_action_policy("hy-embodied-vla-robotwin", SOURCE, ("hy_vla", "robotwin_eval"),
                            serve_hy_vla, "robotwin-aloha-agilex-absolute-ee/1", 1, 32, flash_attention=True)
