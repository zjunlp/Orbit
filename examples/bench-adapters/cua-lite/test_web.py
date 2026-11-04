"""File/protocol fixtures, not live browser or model calibration."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

import adapter
import evidence
import judge
import prepare_backend
from web_suites import WEB_SUITES, capture_judge


class WebAdapterTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def request(self, suite):
        detail = WEB_SUITES[suite]
        return {'benchmark': {'path': str(self.root), 'config': {
            'image': 'sha256:' + '1' * 64, detail['image']: 'sha256:' + '2' * 64}},
            'trial': {'task': suite + '@' + sorted(detail['tasks'])[0], 'seed': 1,
                'staging': str(self.root / 'stage'), 'method': {'name': 'empty', 'agent': 'empty'}}}

    def test_plans_use_a_private_native_service_and_separate_judge_phase(self):
        for suite in WEB_SUITES:
            req = self.request(suite)
            with patch.object(adapter, 'settings', return_value=(self.root, req['benchmark']['config'], 10)), \
                 patch.object(adapter, 'readiness', return_value=None), \
                 patch.object(adapter, 'web_readiness', return_value=None):
                spec = adapter.solve(req)['spec']
            self.assertEqual(len(spec['services']), 1)
            service = spec['services'][0]
            self.assertEqual(service['env'][WEB_SUITES[suite]['prefix'] + '_INSTANCES'], '1')
            self.assertEqual(service['image'], 'sha256:' + '2' * 64)
            self.assertEqual(spec['after']['command'], ['python', '/adapter/judge.py'])
            self.assertNotIn('passEnv', spec['after'])
            self.assertNotIn('OPENAI_API_KEY', json.dumps(spec))
            self.assertNotIn('docker.sock', json.dumps(spec))
            self.assertNotIn('/miniwob', json.dumps(spec))
            self.assertEqual(evidence.read(self.root / 'stage/plan.json')['max_steps'], WEB_SUITES[suite]['steps'])
            if suite == 'webharbor.webvoyager':
                self.assertEqual(service['networks'], ['browser'])
            else:
                self.assertEqual(service['networks'], ['default', 'browser'])

    def test_backend_readiness_checks_immutable_image_and_source_labels(self):
        suite = 'online_mind2web'
        self.assertIn('immutable', adapter.web_readiness({'onlineMind2WebImage': 'native:latest'}, suite))
        config = self.request(suite)['benchmark']['config']
        image = [{'Config': {'Labels': {}}}]
        with patch.object(adapter.subprocess, 'check_output', return_value=json.dumps(image).encode()):
            self.assertIn('labels', adapter.web_readiness(config, suite))
        image[0]['Config']['Labels'] = {'orbit.cua-lite.source': evidence.COMMIT, 'orbit.cua-lite.suite': suite}
        with patch.object(adapter.subprocess, 'check_output', return_value=json.dumps(image).encode()), \
             patch.object(adapter, 'readiness', return_value=None):
            self.assertIsNone(adapter.web_readiness(config, suite))

    def test_capture_preserves_exact_native_buffers_before_close(self):
        plan = {'task': 'webharbor.webvoyager@allrecipes.0'}
        native = SimpleNamespace(_task_id='allrecipes.0', _task={'instruction': 'fixture'},
            max_steps=15, _agent_response='fixture answer', _screenshots=[b'frame one', b'frame two'])
        capture_judge(SimpleNamespace(unwrapped=native), self.root, plan)
        state = evidence.read(self.root / 'judge-input.json')
        native._screenshots.clear()
        self.assertEqual([(self.root / n).read_bytes() for n in state['images']], [b'frame one', b'frame two'])
        self.assertEqual(state['agent_response'], 'fixture answer')

    def capture(self, suite='webharbor.webvoyager', reward=1, info=None, failure=None):
        task = sorted(WEB_SUITES[suite]['tasks'])[0]
        out = self.root / 'output'
        out.mkdir(exist_ok=True)
        (out / 'judge-input').mkdir(exist_ok=True)
        (out / 'judge-input/0000.png').write_bytes(b'explicit frame fixture')
        evidence.write(out / 'plan.json', {'schema': 1, 'commit': evidence.COMMIT,
            'miniwob_commit': evidence.MINIWOB_COMMIT, 'task': suite + '@' + task,
            'seed': 1, 'method': {'name': 'empty', 'agent': 'empty'}, 'max_steps': 15,
            'deferred_judge': True})
        evidence.write(out / 'result.json', {'reward': None, 'steps': 1})
        events = [{'kind': 'reset'}, {'kind': 'step', 'reward': None,
            'terminated': True, 'truncated': False, 'info': {}}]
        (out / 'events.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in events))
        evidence.write(out / 'judge-input.json', {'schema': 1, 'suite': suite, 'task_id': task,
            'task': {'instruction': 'fixture'}, 'max_steps': 15, 'model': WEB_SUITES[suite]['model'],
            'images': ['judge-input/0000.png'], 'agent_response': None,
            'trajectory_steps': [{'action': 'fixture action'}]})
        result = {'commit': evidence.COMMIT, 'suite': suite, 'task_id': task,
            'input_sha256': evidence.digest(out / 'judge-input.json'), 'reward': reward, 'info': info or {}}
        if failure:
            result.update(failure=failure, error_type='ExplicitFixtureError')
        evidence.write(out / 'judge-result.json', result)
        evidence.write(out / 'manifest.json', {path.relative_to(out).as_posix(): evidence.digest(path)
            for path in out.rglob('*') if path.is_file() and path.name != 'manifest.json'})
        return out

    def test_terminal_judge_reward_and_native_no_answer_semantics(self):
        for suite in WEB_SUITES:
            for value in (0, 1):
                report = evidence.validate(self.capture(suite, value))
                self.assertEqual(report['score'], value)
                self.assertFalse(report['invalid'])
        report = evidence.validate(self.capture(reward=None, info={'eval_skip_reason': 'no_agent_response'}))
        self.assertEqual(report['score'], 0)
        for suite in WEB_SUITES:
            with self.assertRaisesRegex(ValueError, 'binary reward'):
                evidence.validate(self.capture(suite, None))

    def test_missing_or_failed_judge_cannot_become_zero(self):
        for failure in ('judge_unavailable', 'scorer_error'):
            report = evidence.validate(self.capture(failure=failure))
            self.assertTrue(report['invalid'])
            self.assertIsNone(report['score'])
            self.assertEqual(report['failure'], failure)
        out = self.capture()
        (out / 'judge-result.json').unlink()
        manifest = evidence.read(out / 'manifest.json')
        del manifest['judge-result.json']
        evidence.write(out / 'manifest.json', manifest)
        with self.assertRaisesRegex(ValueError, 'did not produce'):
            evidence.validate(out)
        self.assertTrue(evidence.validate(out, allow_pending_judge=True)['invalid'])

    def test_judge_failure_saves_only_classification_not_provider_details(self):
        out = self.capture()
        with patch.object(judge, 'restore_native', side_effect=ConnectionError('sensitive provider detail')):
            self.assertEqual(asyncio.run(judge.run(out)), 1)
        self.assertNotIn('sensitive', (out / 'judge-result.json').read_text())
        self.assertEqual(evidence.validate(out)['failure'], 'judge_unavailable')
        req = self.request('webharbor.webvoyager')
        req.update(solve={'output': str(out)}, verify={'output': str(out)})
        self.assertEqual(adapter.score(req)['failure'], 'judge_unavailable')
        self.assertIsNone(adapter.score(req)['score'])

    def test_webvoyager_missing_key_is_invalid_even_without_an_answer(self):
        class EnvDepsMissingError(Exception):
            pass
        for answer in (None, 'fixture answer'):
            out = self.capture()
            state = evidence.read(out / 'judge-input.json')
            state['agent_response'] = answer
            evidence.write(out / 'judge-input.json', state)
            manifest = evidence.read(out / 'manifest.json')
            manifest['judge-input.json'] = evidence.digest(out / 'judge-input.json')
            evidence.write(out / 'manifest.json', manifest)
            native = SimpleNamespace(_require_eval_deps=lambda: (_ for _ in ()).throw(EnvDepsMissingError()))
            with patch.object(judge, 'restore_native', return_value=native):
                self.assertEqual(asyncio.run(judge.run(out)), 1)
            self.assertEqual(evidence.validate(out)['failure'], 'judge_unavailable')

    def test_native_backend_preparation_preserves_source_and_refuses_overwrite(self):
        suite = 'online_mind2web'
        source = self.root / 'lite/gym/envs/online_mind2web/docker'
        source.mkdir(parents=True)
        original = 'FROM python:fixture\nENTRYPOINT ["/usr/local/bin/entrypoint.sh"]\n'
        (source / 'Dockerfile').write_text(original)
        destination = self.root / 'copy'
        with patch.object(prepare_backend, 'checkout'):
            result = prepare_backend.prepare(self.root, suite, destination)
            with self.assertRaisesRegex(ValueError, 'existing files'):
                prepare_backend.prepare(self.root, suite, destination)
        self.assertEqual((source / 'Dockerfile').read_text(), original)
        self.assertTrue(result.read_text().startswith(original))
        self.assertIn('orbit.cua-lite.source', result.read_text())
        self.assertIn('CMD ["/usr/local/bin/entrypoint.sh"]', result.read_text())


if __name__ == '__main__':
    unittest.main()
