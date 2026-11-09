"""The fork reuses initial states under several different task naming rules."""

from pathlib import Path
import unittest

from orbit_embodied.libero_plus import initial_state_path


class LiberoPlusResetTests(unittest.TestCase):
    def test_native_aliases_and_layout_states(self):
        root = Path("init_files")
        suite = "libero_spatial"
        for suffix in ("_table_1", "_tb_2", "_view_0_0_100_0_0_initstate_5_noise_12",
                       "_light_3", "_language_4_view_0_0_100_0_0_initstate_0"):
            self.assertEqual(initial_state_path(root, suite, "task" + suffix), root / suite / "task.pruned_init")
        for suffix in ("_add_bowl", "_level3_3"):
            name = "task" + suffix
            self.assertEqual(initial_state_path(root, suite, name),
                             root / "libero_newobj" / suite / (name + ".pruned_init"))
