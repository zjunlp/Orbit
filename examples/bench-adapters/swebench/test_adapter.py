"""Synthetic privacy, integrity and failure checks; not a substitute for native calibration."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import adapter

class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.req = {'benchmark': {'path': str(self.root), 'config': {}}, 'trial': {
            'task': 'a', 'staging': str(self.root/'stage'), 'method': {'agent': 'codex'}}}
        self.row = {'instance_id': 'a', 'repo': 'fixture', 'base_commit': 'abcd', 'problem_statement': 'Fix the issue',
            'patch': 'secret reference', 'test_patch': 'secret tests', 'FAIL_TO_PASS': '["secret criterion"]'}
        mock = patch.object(adapter, 'inputs', return_value=([self.row], 'hash', {'a': 'sha256:'+'a'*64}))
        mock.start(); self.addCleanup(mock.stop)

    def test_subject_cannot_read_grading_data(self):
        run = adapter.solve(self.req)['spec']
        task = json.loads((self.root/'stage/solve/task.json').read_text())
        self.assertNotIn('patch', task)
        self.assertNotIn('secret', json.dumps(task))
        self.assertEqual({x['target'] for x in run['mounts']}, {'/input', '/adapter/runtime.py'})

    def test_image_change_rejected_during_verification(self):
        adapter.solve(self.req)
        solve = self.root/'saved/collected/input'; solve.mkdir(parents=True)
        saved = json.loads((self.root/'stage/solve/task.json').read_text())
        saved['source']['image'] = 'sha256:'+'b'*64
        (solve/'task.json').write_text(json.dumps(saved))
        self.req['solve'] = {'output': str(self.root/'saved')}
        with self.assertRaisesRegex(ValueError, 'changed'):
            adapter.stage(self.req, 'verify')

    def test_broken_grader_is_invalid_and_false_is_valid_zero(self):
        self.req['verify'] = {'output': str(self.root)}
        self.assertTrue(adapter.score(self.req)['invalid'])
        (self.root/'result.json').write_text(json.dumps({'task': 'a', 'resolved': False}))
        self.assertEqual(adapter.score(self.req)['score'], 0)
        self.assertFalse(adapter.score(self.req)['invalid'])
