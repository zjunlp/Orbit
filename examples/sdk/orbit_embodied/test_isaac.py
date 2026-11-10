"""Driver-query doubles exercise the compatibility boundary; no simulator or GPU is started."""

from contextlib import redirect_stdout
import io
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from orbit_embodied import isaac


class IsaacDriverTests(unittest.TestCase):
    def query(self, output):
        with patch.object(isaac.sys, "platform", "linux"), \
                patch.object(isaac.subprocess, "run", return_value=SimpleNamespace(stdout=output)) as run, \
                redirect_stdout(io.StringIO()) as log:
            args = isaac.driver_version_kit_args()
        run.assert_called_once_with(
            ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
            check=True, capture_output=True, text=True, timeout=5,
        )
        return args, log.getvalue()

    def test_known_r535_boundary_and_multiple_consistent_gpus(self):
        for version in ("535.256", "535.256.01", "535.309.01"):
            with self.subTest(version=version):
                args, log = self.query(version + "\n" + version + "\n")
                self.assertEqual(args, "--/rtx/verifyDriverVersion/enabled=false")
                self.assertIn(version, log)
                self.assertIn("documented", log)
                self.assertIn(isaac.DRIVER_ISSUE, log)

    def test_unaffected_versions_keep_native_verification(self):
        for version in ("535.255", "535.129.03", "525.147.05", "550.309.01", "580.65.06"):
            with self.subTest(version=version):
                args, log = self.query(version + "\n")
                self.assertEqual(args, "")
                self.assertIn("keeping native driver verification", log)

    def test_malformed_empty_or_conflicting_results_keep_native_verification(self):
        for output in ("", "\n", "N/A", "535.309.01-extra", "535.309.01, 0", "535", "535.-1",
                       "535.309.01\n535.255\n", "535.309.01\n\n535.309.01"):
            with self.subTest(output=output):
                args, _ = self.query(output)
                self.assertEqual(args, "")

    def test_failed_bounded_query_keeps_native_verification(self):
        for error in (FileNotFoundError(), subprocess.CalledProcessError(1, "nvidia-smi"),
                      subprocess.TimeoutExpired("nvidia-smi", 5), UnicodeError()):
            with self.subTest(error=type(error).__name__), patch.object(isaac.sys, "platform", "linux"), \
                    patch.object(isaac.subprocess, "run", side_effect=error), redirect_stdout(io.StringIO()):
                self.assertEqual(isaac.driver_version_kit_args(), "")

    def test_non_linux_does_not_query_or_change_driver_verification(self):
        for platform in ("win32", "darwin"):
            with self.subTest(platform=platform), patch.object(isaac.sys, "platform", platform), \
                    patch.object(isaac.subprocess, "run") as run:
                self.assertEqual(isaac.driver_version_kit_args(), "")
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
