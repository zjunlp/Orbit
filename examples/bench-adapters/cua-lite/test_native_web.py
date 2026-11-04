"""Opt-in checks of original evaluator functions; images are fixtures, with no browser/model run."""
import asyncio
import importlib
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from evidence import check_judge_verdict, read
from judge import restore_native
from web_suites import WEB_SUITES


@unittest.skipUnless(os.environ.get('ORBIT_LITE_NATIVE_TEST') == '1',
                     'Requires Python 3.12 and the pinned native source on PYTHONPATH')
class NativeJudgeBoundaryTest(unittest.TestCase):
    def native(self, suite):
        detail = WEB_SUITES[suite]
        module = importlib.import_module('lite.gym.envs.' + detail['path'].replace('/', '.') + '.main')
        task_id = sorted(detail['tasks'])[0]
        if suite == 'online_mind2web':
            task = next(t for t in module._load_tasks() if t['task_id'] == task_id)
        else:
            task = read(Path(module.__file__).parent / 'data/tasks.json')[task_id]
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        output = Path(temp.name)
        (output / 'frame.png').write_bytes(b'explicit evaluator-buffer fixture')
        state = {'suite': suite, 'task_id': task_id, 'task': task, 'max_steps': detail['steps'],
                 'images': ['frame.png'], 'agent_response': None,
                 'trajectory_steps': [{'action': 'initial observation'}]}
        return restore_native(state, output), state

    def test_webvoyager_native_buffer_no_answer_and_required_key(self):
        native, _state = self.native('webharbor.webvoyager')
        self.assertEqual(native._screenshots, [b'explicit evaluator-buffer fixture'])
        self.assertEqual(native._build_eval_config()['model'], 'gpt-4.1')
        with patch.dict(os.environ, {'OPENAI_API_KEY': ''}):
            with self.assertRaises(Exception) as raised:
                native._require_eval_deps()
            self.assertEqual(type(raised.exception).__name__, 'EnvDepsMissingError')
        reward, info = asyncio.run(native._evaluate())
        self.assertIsNone(reward)
        self.assertEqual(info['eval_skip_reason'], 'no_agent_response')

    def test_online_native_actions_single_worker_and_missing_key(self):
        native, state = self.native('online_mind2web')
        self.assertEqual(native._trajectory_steps, state['trajectory_steps'])
        self.assertEqual(native._build_eval_config()['model'], 'o4-mini')
        self.assertEqual(native._build_eval_config()['image_judge_workers'], 1)
        with patch.dict(os.environ, {'OPENAI_API_KEY': ''}):
            with self.assertRaises(Exception) as raised:
                asyncio.run(native._evaluate())
            self.assertEqual(type(raised.exception).__name__, 'EnvDepsMissingError')

    def test_native_malformed_response_fallbacks_are_rejected_by_validity_check(self):
        native, _state = self.native('webharbor.webvoyager')
        native._agent_response = 'explicit provider-response fixture'
        calls = []
        def create(**kwargs):
            calls.append(kwargs)
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='Cannot provide a verdict'))])
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        with patch.dict('sys.modules', {'openai': SimpleNamespace(OpenAI=lambda **kwargs: client)}):
            reward, info = native._vlm_evaluate_sync()
        self.assertEqual(reward, 0)
        self.assertEqual((calls[0]['model'], calls[0]['temperature'], calls[0]['seed']), ('gpt-4.1', 0, 42))
        with self.assertRaisesRegex(ValueError, 'malformed verdict'):
            check_judge_verdict('webharbor.webvoyager', reward, info, 1)
        module = importlib.import_module('lite.gym.envs.online_mind2web.main')
        reward = module._extract_prediction('Cannot provide a verdict', 'WebJudge_Online_Mind2Web_eval')
        self.assertEqual(reward, 0)
        with self.assertRaisesRegex(ValueError, 'malformed verdict'):
            check_judge_verdict('online_mind2web', reward, {'eval_verdict': 'Cannot provide a verdict'}, 1)


if __name__ == '__main__':
    unittest.main()
