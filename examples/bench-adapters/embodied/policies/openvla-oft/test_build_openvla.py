import json
from pathlib import Path
import runpy
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import call, patch


POLICY = Path(__file__).resolve().parent
ADAPTER = POLICY.parents[1]


class OpenVLABuildTests(unittest.TestCase):
    def test_cli_reads_profile_and_passes_pinned_sources_to_docker(self):
        sources = json.loads((ADAPTER / "profiles/openvla-model.json").read_text())["sources"]
        with TemporaryDirectory() as directory:
            argv = [str(POLICY / "build_openvla.py"), "--tag", "orbit/openvla-oft:test"]
            git_calls, git_replies, contexts = [], [], []
            for name, source in sources.items():
                path = str(Path(directory).resolve() / name)
                argv.extend(("--" + name + "-source", path))
                git_calls.extend((
                    call(["git", "-C", path, "rev-parse", "HEAD"], text=True),
                    call(["git", "-C", path, "status", "--porcelain", "--untracked-files=normal"], text=True),
                ))
                git_replies.extend((source["commit"] + "\n", ""))
                contexts.extend(("--build-context", name + "=" + path))

            with patch.object(sys, "argv", argv), \
                    patch("subprocess.check_output", side_effect=git_replies) as git, \
                    patch("subprocess.run") as docker:
                runpy.run_path(argv[0], run_name="__main__")

            self.assertEqual(git.call_args_list, git_calls)
            docker.assert_called_once_with(
                ["docker", "build", "--label", "orbit.task=embodied-eval", "--progress=plain", *contexts,
                 "-t", "orbit/openvla-oft:test", "-f", str(POLICY / "openvla-policy.Dockerfile"),
                 str(ADAPTER.parents[2])],
                check=True,
            )
