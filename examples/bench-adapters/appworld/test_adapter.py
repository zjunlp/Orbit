"""Synthetic service-isolation and trusted-evidence failure fixtures."""
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
        cfg = {'image': 'sha256:'+'a'*64}
        self.req = {'benchmark': {'path': str(self.root), 'config': cfg}, 'trial': {
            'task': 'a', 'staging': str(self.root/'stage'), 'method': {'agent': 'codex'}}}
        mock = patch.object(adapter, 'catalog', return_value=(['a'], self.root, {**cfg, 'dataSha256': 'fixture'}))
        mock.start(); self.addCleanup(mock.stop)

    def test_subject_gets_only_client_and_service_collects_evidence(self):
        spec = adapter.solve(self.req)['spec']
        self.assertEqual([m['target'] for m in spec['mounts']], ['/adapter/tool.py'])
        self.assertEqual(spec['services'][0]['collect'], ['/evidence/trace.json'])
        self.assertIn('/data', [m['target'] for m in spec['services'][0]['binds']])
        self.assertTrue(spec['networks'][0]['internal'])

    def test_missing_trusted_evidence_is_invalid(self):
        self.req['verify'] = {'output': str(self.root)}
        self.assertTrue(adapter.score(self.req)['invalid'])
        (self.root/'result.json').write_text(json.dumps({'task': 'a', 'error': 'service evidence missing'}))
        self.assertTrue(adapter.score(self.req)['invalid'])
        (self.root/'result.json').write_text(json.dumps({'task': 'a', 'success': False}))
        self.assertFalse(adapter.score(self.req)['invalid'])
        self.assertEqual(adapter.score(self.req)['score'], 0)
