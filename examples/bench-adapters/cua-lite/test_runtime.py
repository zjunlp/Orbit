"""Explicit native-environment doubles for runtime outcome/cleanup separation."""
import asyncio
from dataclasses import dataclass, field
from pathlib import Path
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

import evidence
import runtime


@dataclass
class ObservationFixture:
    text: str = 'explicit environment fixture'
    image: object = None
    metadata: dict = field(default_factory=dict)


@dataclass
class StepFixture:
    reward: int = 0
    terminated: bool = True
    truncated: bool = False
    info: dict = field(default_factory=dict)
    results: list = field(default_factory=list)


class CleanupTest(unittest.TestCase):
    def run_fixture(self, step_failure=False):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        plan = root / 'plan.json'
        evidence.write(plan, {'schema': 1, 'commit': evidence.COMMIT,
            'miniwob_commit': evidence.MINIWOB_COMMIT, 'task': 'browsergym.miniwob@click-test',
            'seed': 1, 'max_steps': 10, 'method': {'name': 'empty', 'agent': 'empty'}})

        class NativeFixture:
            async def reset(self):
                return ObservationFixture()
            async def step(self, actions):
                if step_failure:
                    raise ConnectionError('explicit step failure')
                return StepFixture()
            async def close(self):
                raise OSError('explicit close failure')

        class WrapperFixture:
            def __init__(self, env):
                self.env = env
            async def close(self):
                await self.env.close()

        modules = {name: ModuleType(name) for name in
            ('lite', 'lite.gym', 'lite.gym.wrappers', 'lite.core', 'lite.core.tools')}
        modules['lite'].gym = modules['lite.gym']
        modules['lite.gym'].make = lambda *args, **kwargs: NativeFixture()
        modules['lite.gym.wrappers'].EnvWrapper = WrapperFixture
        modules['lite.core.tools'].make_tool_call = lambda *args, **kwargs: {'fixture': True}
        server = SimpleNamespace(serve_forever=lambda: None, shutdown=lambda: None, server_close=lambda: None)
        with patch.dict('sys.modules', modules), patch.object(runtime, 'version', return_value='0.14.3'), \
             patch.object(runtime, 'ThreadingHTTPServer', return_value=server):
            code = asyncio.run(runtime.run(plan, root / 'output'))
        return code, root / 'output'

    def test_close_failure_preserves_complete_native_reward(self):
        code, output = self.run_fixture()
        result = evidence.read(output / 'result.json')
        self.assertEqual(code, 0)
        self.assertTrue(result['native_close_failed'])
        self.assertEqual(result['cleanup_error_type'], 'OSError')
        self.assertEqual(evidence.validate(output)['score'], 0)
        self.assertFalse(evidence.validate(output)['invalid'])

    def test_close_failure_preserves_original_execution_failure(self):
        code, output = self.run_fixture(step_failure=True)
        result = evidence.read(output / 'result.json')
        self.assertEqual(code, 1)
        self.assertEqual(result['failure'], 'env_step')
        self.assertEqual(result['error_type'], 'ConnectionError')
        self.assertTrue(result['native_close_failed'])
        self.assertEqual(evidence.validate(output)['failure'], 'env_step')


if __name__ == '__main__':
    unittest.main()
