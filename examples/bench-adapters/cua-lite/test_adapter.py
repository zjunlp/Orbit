"""Explicit fixtures only; native Chromium checks are separate development validation."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import adapter
import evidence
from runtime import native_config


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.req = {'protocol': 1, 'op': 'solve', 'benchmark': {'path': str(self.root), 'config': {}},
            'trial': {'task': 'browsergym.miniwob@click-test', 'seed': 3, 'options': {},
                      'staging': str(self.root / 'stage'), 'method': {'name': 'empty', 'agent': 'empty'}}}

    def solve(self):
        with patch.object(adapter, 'settings', return_value=(self.root, {}, 10)), \
             patch.object(adapter, 'miniwob', return_value=self.root), \
             patch.object(adapter, 'readiness', return_value=None):
            return adapter.solve(self.req)['spec']

    def test_single_native_episode_and_private_browser(self):
        spec = self.solve()
        self.assertFalse(spec['network'])
        self.assertEqual(spec['env']['MINIWOB_PORT'], '7560')
        self.assertNotIn('docker.sock', json.dumps(spec))
        self.assertNotIn('hostNetwork', spec)
        self.assertEqual(evidence.read(self.root / 'stage/plan.json')['seed'], 3)
        self.assertTrue(all(m['mode'] == 'ro' for m in spec['mounts']))

    def test_unsupported_suites_and_options_are_refused(self):
        self.req['trial']['task'] = 'online_mind2web@fixture'
        with self.assertRaises(ValueError):
            self.solve()
        self.req['trial']['task'] = 'browsergym.miniwob@click-test'
        self.req['trial']['options'] = {'extra_dom': 'true'}
        with self.assertRaises(ValueError):
            self.solve()
        self.assertEqual(native_config({'temperature': '0.5', 'enabled': 'false', 'name': 'sample'}),
                         {'temperature': .5, 'enabled': False, 'name': 'sample'})

    def capture(self, reward=0, failure=None, terminal=True, pool=False):
        out = self.root / 'output'
        out.mkdir(exist_ok=True)
        evidence.write(out / 'plan.json', {'commit': evidence.COMMIT, 'miniwob_commit': evidence.MINIWOB_COMMIT,
            **{k: self.req['trial'][k] for k in ('task', 'seed', 'method')}})
        result = {'reward': reward, 'steps': 1}
        if failure:
            result.update(failure=failure, error_type='InjectedFixtureError')
        evidence.write(out / 'result.json', result)
        events = [{'kind': 'reset', 'image': None, 'text': 'fixture'}, {'kind': 'step',
            'terminated': terminal, 'truncated': False, 'reward': reward,
            'info': {'pool_unreachable': pool}, 'results': []}]
        (out / 'events.jsonl').write_text(''.join(json.dumps(e) + '\n' for e in events))
        evidence.write(out / 'manifest.json', {n: evidence.digest(out / n)
            for n in ('plan.json', 'result.json', 'events.jsonl')})
        return out

    def test_native_binary_reward_and_final_verdict(self):
        for reward in (0, 1):
            report = evidence.validate(self.capture(reward))
            self.assertFalse(report['invalid'])
            self.assertEqual(report['score'], reward)
            self.assertEqual(report['episode']['steps'], 1)
        for reward in (None, .5, True):
            with self.assertRaises(ValueError):
                evidence.validate(self.capture(reward))
        with self.assertRaises(ValueError):
            evidence.validate(self.capture(terminal=False))

    def test_native_failures_are_invalid_never_zero(self):
        for failure in ('env_start', 'reset_failed', 'scorer_error', 'model_unavailable'):
            result = evidence.validate(self.capture(failure=failure))
            self.assertEqual(result['failure'], failure)
            self.assertTrue(result['invalid'])
            self.assertIsNone(result['score'])
        result = evidence.validate(self.capture(pool=True))
        self.assertTrue(result['invalid'])
        self.assertEqual(result['failure'], 'server_unreachable')

    def test_evidence_tampering_and_trial_identity(self):
        out = self.capture()
        (out / 'events.jsonl').write_text('')
        with self.assertRaisesRegex(ValueError, 'Changed evidence'):
            evidence.validate(out)
        out = self.capture()
        verifier = self.root / 'verify'
        verifier.mkdir()
        evidence.write(verifier / 'validation.json', evidence.validate(out))
        self.req.update(solve={'output': str(out)}, verify={'output': str(verifier)})
        self.assertFalse(adapter.score(self.req)['invalid'])
        self.req['trial']['seed'] = 99
        self.assertEqual(adapter.score(self.req)['failure'], 'scorer_error')
        manifest = evidence.read(out / 'manifest.json')
        manifest['../outside'] = 'fixture'
        evidence.write(out / 'manifest.json', manifest)
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            evidence.validate(out)


if __name__ == '__main__':
    unittest.main()
