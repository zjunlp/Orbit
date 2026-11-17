"""Synthetic export audit and immutable-statement fixtures."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import adapter
import runtime

class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.req = {'benchmark': {'path': str(self.root), 'config': {}}, 'trial': {
            'task': 'test/fixture', 'staging': str(self.root/'stage'), 'method': {'agent': 'codex'}}}
        row = {'task':'test/fixture','name':'fixture','prelude':'import minif2f_import\n',
               'statement':'theorem fixture : 1 = 1 :=\n','proof':'begin refl end'}
        for name, value in [('rows', [row]), ('installation', (self.root, 'hash', {'image':'python:fixture'}))]:
            mock = patch.object(adapter, name, return_value=value); mock.start(); self.addCleanup(mock.stop)

    def test_reference_hidden_and_original_statement_retained(self):
        run = adapter.solve(self.req)['spec']
        visible = json.loads((self.root/'stage/solve/task.json').read_text())
        self.assertNotIn('proof', visible)
        self.assertEqual(visible['statement'], 'theorem fixture : 1 = 1 :=\n')
        self.assertEqual(run['env']['LEAN_PATH'], '/imports:/tools/mathlib/src:/tools/lean/lib/lean/library')

    def test_dependency_audit_rejects_sorry_and_requires_target(self):
        file = self.root/'export.tlean'
        file.write_text('1 #NS 0 sorry_ax\n2 #NS 0 fixture\n#AX 1 0\n#DEF 2 0 1\n')
        self.assertEqual(runtime.export_axioms(file, 'fixture') - runtime.ALLOWED_AXIOMS, {'sorry_ax'})
        self.assertRaisesRegex(ValueError, 'missing', runtime.export_axioms, file, 'other')
        file.write_text('1 #NS 0 propext\n2 #NS 0 fixture\n#AX 1 0\n#DEF 2 0 1\n')
        self.assertFalse(runtime.export_axioms(file, 'fixture') - runtime.ALLOWED_AXIOMS)

    def test_empty_proof_is_zero_without_running_kernel(self):
        result = runtime.check({'task':'test/fixture'}, '', self.root, lean='/missing', checker='/missing')
        self.assertFalse(result['proved'])
        self.assertEqual(result['reason'], 'empty_proof')

    def test_import_timeout_is_an_infrastructure_failure(self):
        item = {'task': 'test/fixture', 'prelude': 'import minif2f_import\n'}
        with patch.object(runtime.subprocess, 'run', side_effect=runtime.subprocess.TimeoutExpired('lean', 180)):
            self.assertRaisesRegex(RuntimeError, 'imports/toolchain timed out', runtime.check, item, 'begin refl end', self.root)
