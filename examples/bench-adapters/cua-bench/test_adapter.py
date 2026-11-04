"""Explicit source/result fixtures; these tests never start a desktop or call a model."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import adapter
import evidence
import runtime
from trajectory import capture as capture_frames


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.req = {'protocol': 1, 'op': 'solve', 'benchmark': {
            'name': 'fixture', 'path': str(self.root), 'config': {}}, 'trial': {
            'id': 'fixture-trial', 'task': 'cua-bench-basic/click-button@0', 'seed': 3,
            'staging': str(self.root / 'stage'), 'options': {}, 'hostNetwork': False,
            'method': {'name': 'empty', 'agent': 'empty'}}}
        self.row = {'id': self.req['trial']['task'], 'path': 'cua-bench-basic/click-button',
                    'variant': 0, 'title': 'Fixture button', 'source_sha256': 'fixture',
                    'computer': {'provider': 'native', 'setup_config': {'os_type': 'linux',
                        'image': evidence.DESKTOP_IMAGE, 'width': 1024, 'height': 768}}}

    def solve(self):
        with patch.object(adapter, 'checkout'), patch.object(adapter, 'readiness', return_value=None), \
             patch.object(adapter, 'catalog', return_value=[self.row]):
            return adapter.solve(self.req)['spec']

    def test_single_episode_uses_owned_service_and_private_token_volume(self):
        spec = self.solve()
        self.assertEqual(len(spec['services']), 1)
        self.assertEqual(spec['services'][0]['image'], evidence.DESKTOP_IMAGE)
        self.assertEqual(spec['services'][0]['shmGB'], 2)
        self.assertEqual(spec['services'][0]['healthcheck']['command'][0], 'sh')
        self.assertEqual(spec['volumeMounts'][0]['mode'], 'ro')
        self.assertNotIn('collect', spec['services'][0])
        self.assertNotIn('CUA_ENV_TOKEN', json.dumps(spec))
        self.assertNotIn('docker.sock', json.dumps(spec))
        plan = evidence.read(self.root / 'stage/plan.json')
        self.assertEqual(plan['native']['variant'], 0)

    def test_external_options_and_resources_are_not_silently_dropped(self):
        self.req['trial']['method'] = {'agent': 'external', 'name': 'native', 'entrypoint': 'my_agent:Agent',
                                        'config': {'maxSteps': '7'}, 'passEnv': ['MODEL_KEY']}
        self.req['trial']['resources'] = {'cpus': 3, 'memGB': 8, 'gpus': 0}
        spec = self.solve()
        self.assertEqual(spec['resources']['memGB'], 8)
        self.assertEqual(evidence.read(self.root / 'stage/plan.json')['max_steps'], 7)
        self.req['trial']['method']['config']['secret'] = 'refused'
        with self.assertRaises(ValueError):
            self.solve()

    def test_unknown_and_unsupported_tasks_refused(self):
        self.req['trial']['task'] = '../../outside'
        with self.assertRaises(ValueError):
            self.solve()
        self.assertIsNotNone(adapter.reason({'path': 'cua-bench-workflows/unity-tasks'}))
        self.assertIsNotNone(adapter.reason({'path': 'cua-bench-kicad/circuit'}))

    def test_review_uses_only_native_post_action_frames(self):
        rows = [{'event_name': 'reset', 'data_images': [b'fixture png'], 'data_json': '{}'},
                {'event_name': 'agent_step', 'data_images': [b'unknown timing'], 'data_json': '{}'},
                {'event_name': 'solve', 'data_images': [b'fixture result'], 'data_json': '{}'}]
        capture_frames(rows, self.root, 'fixture')
        view = evidence.read(self.root / 'trajectory-review.json')
        self.assertEqual(len(view['steps']), 2)
        self.assertIsNone(view['steps'][0]['action'])
        self.assertIn('solve_task', view['steps'][1]['action'])
        self.assertIsNone(view['steps'][1]['reward'])

    def capture(self, native=None, failure=None):
        out = self.root / 'output'
        out.mkdir(exist_ok=True)
        plan = {'commit': evidence.COMMIT, 'desktop_image': evidence.DESKTOP_IMAGE,
                **{k: self.req['trial'][k] for k in ('task', 'seed', 'method')}}
        evidence.write(out / 'plan.json', plan)
        result = {'native': native or {'reward': 0, 'evaluation': [0], 'success': True}}
        if failure:
            result.update(failure=failure, error_type='InjectedFixtureError')
        evidence.write(out / 'result.json', result)
        evidence.write(out / 'manifest.json', {n: evidence.digest(out / n) for n in ('plan.json', 'result.json')})
        return out

    def test_original_reward_is_independent_from_success(self):
        out = self.capture({'reward': .5, 'evaluation': [.5], 'success': False,
                            'failure_mode': 'FailureMode.MAX_STEPS_EXCEEDED'})
        report = evidence.validate(out)
        self.assertEqual(report['score'], .5)
        self.assertFalse(report['invalid'])
        self.assertFalse(evidence.validate(self.capture())['invalid'])

    def test_evaluator_failure_and_provider_failure_never_become_valid_zero(self):
        report = evidence.validate(self.capture(failure='scorer_error'))
        self.assertTrue(report['invalid'])
        self.assertEqual(report['failure'], 'scorer_error')
        self.assertIsNone(report['score'])
        report = evidence.validate(self.capture({'reward': 0, 'evaluation': [0],
                                                'failure_mode': 'FailureMode.API_ERROR'}))
        self.assertTrue(report['invalid'])
        self.assertEqual(report['failure'], 'model_unavailable')

    def test_close_errors_do_not_replace_the_evaluation_and_both_closes_are_attempted(self):
        calls = []

        class BrokenSession:
            async def close(self):
                calls.append('session')
                raise RuntimeError('explicit session close fixture')

        class BrokenSandbox:
            async def disconnect(self):
                calls.append('sandbox')
                raise ConnectionError('explicit sandbox close fixture')

        for failure in (None, 'scorer_error'):
            out = self.capture({'reward': 1, 'evaluation': [1], 'success': True}, failure)
            result = evidence.read(out / 'result.json')
            asyncio.run(runtime.close_connections(result, BrokenSession(), BrokenSandbox()))
            self.assertEqual(result['connection_close_errors'],
                             {'session': 'RuntimeError', 'sandbox': 'ConnectionError'})
            evidence.write(out / 'result.json', result)
            evidence.write(out / 'manifest.json',
                           {n: evidence.digest(out / n) for n in ('plan.json', 'result.json')})
            report = evidence.validate(out)
            if failure:
                self.assertTrue(report['invalid'])
                self.assertEqual(report['failure'], failure)
            else:
                self.assertFalse(report['invalid'])
                self.assertEqual(report['score'], 1)
        self.assertEqual(calls, ['session', 'sandbox', 'session', 'sandbox'])

    def test_optional_media_failure_does_not_replace_the_original_reward(self):
        out = self.capture({'reward': 1, 'evaluation': [1], 'success': True})
        result = evidence.read(out / 'result.json')
        env = SimpleNamespace(tracing=SimpleNamespace(_rows=[
            {'event_name': 'reset', 'data_images': [object()], 'data_json': '{}'}]))
        runtime.capture_review(result, env, out, 'Explicit invalid media fixture')
        self.assertEqual(result['trajectory_error_type'], 'AttributeError')
        evidence.write(out / 'result.json', result)
        evidence.write(out / 'manifest.json',
                       {n: evidence.digest(out / n) for n in ('plan.json', 'result.json')})
        report = evidence.validate(out)
        self.assertFalse(report['invalid'])
        self.assertEqual(report['score'], 1)

    def test_missing_changed_and_nonfinite_evidence(self):
        out = self.capture()
        (out / 'result.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'Changed evidence'):
            evidence.validate(out)
        out = self.capture({'reward': None, 'evaluation': None})
        with self.assertRaises(ValueError):
            evidence.validate(out)
        evidence.write(out / 'manifest.json', {'../escape': 'a'})
        with self.assertRaises(ValueError):
            evidence.validate(out)

    def test_score_checks_trial_identity_and_verifier_agreement(self):
        out = self.capture()
        verifier = self.root / 'verify'
        verifier.mkdir()
        evidence.write(verifier / 'validation.json', evidence.validate(out))
        self.req.update(solve={'output': str(out)}, verify={'output': str(verifier)})
        self.assertFalse(adapter.score(self.req)['invalid'])
        self.req['trial']['seed'] = 99
        self.assertTrue(adapter.score(self.req)['invalid'])


if __name__ == '__main__':
    unittest.main()
