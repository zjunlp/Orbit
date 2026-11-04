"""Signed GUI contract tests with explicit backend fixtures, without a native browser."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import adapter
from server import CuaLiteBackend, service


class NativeFixture:
    def reset(self):
        return {'screenshot': b'explicit PNG fixture', 'goal': 'fixture goal'}

    def spec(self):
        return {'action_set': 'canonical', 'stop_action': json.dumps({
            'type': 'function', 'function': {'name': 'terminate', 'arguments': {'status': 'success'}}})}

    def step(self, action):
        terminal = json.loads(action)['function']['name'] == 'terminate'
        reward = 0 if terminal else None
        return (self.reset(), reward, terminal, False, {'task_info': {
            'native_reward': reward, 'native_terminated': terminal, 'native_truncated': False,
            'pool_unreachable': False}})

    def close(self):
        pass


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.req = {'protocol': 1, 'op': 'solve', 'benchmark': {'path': str(self.root), 'config': {}},
            'trial': {'task': 'browsergym.miniwob@click-test', 'seed': 3, 'options': {},
                'staging': str(self.root / 'stage'), 'method': {'name': 'cli', 'agent': 'claude-code'}}}

    def solve(self):
        with patch.object(adapter, 'settings', return_value=(self.root, {}, 10)), \
             patch.object(adapter, 'miniwob', return_value=self.root), \
             patch.object(adapter, 'readiness', return_value=None):
            return adapter.solve(self.req)['spec']

    def test_cli_service_owns_sources_evidence_and_key(self):
        spec = self.solve()
        self.assertEqual(spec['agentTask']['tools'], [{'name': 'orbit-computer', 'command': ['orbit-computer', 'mcp']}])
        self.assertEqual(spec['env']['ORBIT_GUI_URL'], 'http://gui:8765')
        self.assertEqual(spec['runNetworks'], ['default', 'gui'])
        self.assertEqual(spec['networks'], [{'name': 'gui', 'internal': True}])
        self.assertEqual({m['target'] for m in spec['mounts']}, {'/usr/local/bin/orbit-computer', '/tools/orbit-computer.py'})
        gui = spec['services'][0]
        self.assertEqual(gui['networks'], ['gui'])
        self.assertEqual(gui['collect'], ['/evidence'])
        self.assertTrue(all(m['mode'] == 'ro' for m in gui['binds']))
        self.assertNotIn(adapter.gui_evidence.PUBLIC_KEY_ENV, spec['env'])
        plan = adapter.read(self.root / 'stage/plan.json')
        self.assertEqual(plan['backend'], 'cua-lite')
        self.assertEqual(plan['action_set'], 'canonical')
        self.assertEqual(plan['commit'], adapter.COMMIT)
        self.assertEqual((self.root / 'stage/evidence-private.pem').stat().st_mode & 0o777, 0o600)
        subprocess.run([sys.executable, '-B', '-c',
            "from importlib import import_module; import_module('orbit-gui-service.service'); import server"],
            cwd=self.root / 'stage', check=True, capture_output=True)

    def test_cli_refuses_web_and_uncalibrated_tasks(self):
        for task in ('webharbor.webvoyager@allrecipes.0', 'online_mind2web@fixture', 'browsergym.miniwob@click-tab'):
            self.req['trial']['task'] = task
            with self.assertRaisesRegex(ValueError, 'CLI unsupported'):
                self.solve()

    def capture(self):
        spec = self.solve()
        stage = self.root / 'stage'
        output = self.root / 'output/services/gui/evidence'
        episode = service.Episode(stage / 'plan.json', output, NativeFixture(), stage / 'evidence-private.pem')
        episode.start()
        episode.step(json.dumps({'type': 'function', 'function': {'name': 'computer', 'arguments': {'actions': []}}}), 'one')
        episode.finish()
        self.req['solve'] = {'output': str(self.root / 'output'), 'run': {'spec': spec}}
        self.req['verify'] = {'output': str(self.root / 'verify')}
        (self.root / 'verify').mkdir()
        key = adapter.gui_adapter.trusted_public_key(self.req)
        report = adapter.gui_evidence.validate(output, key)
        adapter.write(self.root / 'verify/validation.json', report)
        return output, key

    def test_signed_native_nullable_intermediate_reward_and_rescore(self):
        output, key = self.capture()
        self.assertEqual(adapter.gui_evidence.validate(output, key)['reward'], 0)
        score = adapter.score(self.req)
        self.assertFalse(score['invalid'])
        self.assertEqual(score['episode']['steps'], 2)
        self.assertTrue(score['episode']['terminated'])
        verify = adapter.verify(self.req)['spec']
        self.assertFalse(verify['network'])
        self.assertEqual(verify['mounts'][0]['source'], str(adapter.gui_adapter.HERE / 'evidence.py'))
        self.req['trial']['seed'] = 4
        self.assertTrue(adapter.score(self.req)['invalid'])

    def test_signature_and_saved_run_key_are_required(self):
        output, _key = self.capture()
        self.req['solve']['run']['spec']['services'] = []
        self.assertTrue(adapter.score(self.req)['invalid'])
        with self.assertRaises(adapter.gui_evidence.SignatureError):
            adapter.verify(self.req)
        (output / 'result.json').write_text('{}')
        self.assertTrue(adapter.score(self.req)['invalid'])

    def test_native_verdict_must_agree_with_trajectory(self):
        output, _key = self.capture()
        rows = [json.loads(line) for line in (output / 'trajectory.jsonl').read_text().splitlines()]
        rows[-1]['task_info']['native_reward'] = 1
        (output / 'trajectory.jsonl').write_text('\n'.join(json.dumps(row) for row in rows))
        with self.assertRaisesRegex(ValueError, 'disagrees with the native'):
            adapter.gui_evidence.validate(output)

    def test_malformed_action_is_recoverable_and_native_frames_are_preserved(self):
        backend = CuaLiteBackend({})
        self.addCleanup(backend.close)
        backend.obs = {'screenshot': b'previous fixture', 'goal': 'fixture goal'}
        observed = []
        async def step(calls):
            observed.extend(calls)
            return SimpleNamespace(results=[], reward=0, terminated=True, truncated=False, info={})
        async def close():
            pass
        backend.env = SimpleNamespace(step=step, close=close)
        validator = SimpleNamespace(validate_lite_tool_call=lambda call, where, require_id: None if isinstance(call, dict) else 'invalid call')
        with patch.dict(sys.modules, {'lite.core.tools.calls': validator}):
            for action in ('not JSON', '[]'):
                with self.assertRaises(service.RequestError) as failure:
                    backend.step(action)
                self.assertEqual(failure.exception.status, 400)
            self.assertEqual(observed, [])
            call = {'type': 'function', 'function': {'name': 'terminate', 'arguments': {}}}
            obs, reward, terminal, truncated, info = backend.step(json.dumps(call))
            self.assertEqual(observed, [{**call, 'id': 'orbit-gui-1'}])
            self.assertEqual(obs['screenshot'], b'previous fixture')
            self.assertEqual(obs['frame_source'], 'previous_observation')
            self.assertIn('preceding observation', obs['text'])
            self.assertEqual((reward, terminal, truncated), (0, True, False))
            self.assertEqual(info['task_info']['native_reward'], 0)


    def test_missing_native_ids_receive_unique_ids_and_return_frames(self):
        backend = CuaLiteBackend({})
        self.addCleanup(backend.close)
        backend.obs = {'screenshot': b'old fixture', 'goal': 'fixture goal'}
        identifiers = []
        async def step(calls):
            identifier = calls[0].get('id')
            identifiers.append(identifier)
            result = SimpleNamespace(images=[identifier.encode()], error='native feedback')
            return SimpleNamespace(results=[result] if identifier else [], reward=None,
                                   terminated=False, truncated=False, info={})
        async def close():
            pass
        backend.env = SimpleNamespace(step=step, close=close)
        validator = SimpleNamespace(validate_lite_tool_call=lambda call, where, require_id: None)
        call = {'type': 'function', 'function': {'name': 'computer', 'arguments': {'actions': []}}}
        with patch.dict(sys.modules, {'lite.core.tools.calls': validator}):
            for expected in ('orbit-gui-1', 'orbit-gui-2'):
                obs, *_ = backend.step(json.dumps(call))
                self.assertEqual(obs['screenshot'], expected.encode())
                self.assertEqual(obs['last_action_error'], 'native feedback')
                self.assertEqual(obs['frame_source'], 'native_step')
            backend.step(json.dumps({**call, 'id': 'caller-supplied'}))
        self.assertEqual(identifiers, ['orbit-gui-1', 'orbit-gui-2', 'caller-supplied'])

    def test_native_argument_errors_are_the_agents_not_an_environment_failure(self):
        backend = CuaLiteBackend({})
        self.addCleanup(backend.close)
        backend.obs = {'screenshot': b'old fixture', 'goal': 'fixture goal'}
        async def step(calls):
            raise ValueError('coordinate out of range')
        async def broken(calls):
            raise RuntimeError('browser crashed')
        async def close():
            pass
        validator = SimpleNamespace(validate_lite_tool_call=lambda call, where, require_id: None)
        call = json.dumps({'type': 'function', 'function': {'name': 'computer', 'arguments': {}}})
        with patch.dict(sys.modules, {'lite.core.tools.calls': validator}):
            backend.env = SimpleNamespace(step=step, close=close)
            with self.assertRaises(service.RequestError) as caught:
                backend.step(call)
            self.assertEqual(caught.exception.status, 400)
            self.assertIn('coordinate out of range', str(caught.exception))
            backend.env = SimpleNamespace(step=broken, close=close)
            with self.assertRaises(RuntimeError):
                backend.step(call)


if __name__ == '__main__':
    unittest.main()
