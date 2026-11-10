"""Transport/planning/evidence tests; test doubles do not validate Isaac Sim execution."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import adapter
import service
import verify

helper_spec = importlib.util.spec_from_file_location('evidence_helpers', HERE.parents[1] / 'tools/orbit-gui-service/evidence.py')
helpers = importlib.util.module_from_spec(helper_spec)
helper_spec.loader.exec_module(helpers)
sys.modules['evidence_helpers'] = helpers


class EmbodiedLabAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'scripts').mkdir()
        (self.root / 'scripts/trial.py').write_text('# Explicit planning fixture, not a native environment.\n')
        self.req = {'benchmark': {'path': str(self.root), 'config': {}},
                    'trial': {'task': 'pendulum_g', 'seed': 0, 'method': {'agent': 'claude-code'},
                              'staging': str(self.root / 'staging'), 'options': {}, 'hostNetwork': False}}
        self.revision = patch.object(adapter, 'revision')
        self.revision.start()

    def tearDown(self):
        self.revision.stop()
        self.temp.cleanup()

    def test_all_native_tasks_and_explicit_unsupported_exposure(self):
        reply = adapter.tasks(self.req)
        self.assertEqual(len(reply['tasks']), 30)
        self.assertEqual(reply['official']['unit'], 'task')
        self.req['benchmark']['config']['exposure'] = 'T1'
        with self.assertRaisesRegex(ValueError, 'SAM3'):
            adapter.tasks(self.req)

    def test_service_only_holds_source_truth_and_signing_key(self):
        spec = adapter.solve(self.req)['spec']
        self.assertIn('agentTask', spec)
        self.assertNotIn('command', spec)
        self.assertEqual(spec['resources']['gpus'], 0)
        self.assertEqual(spec['services'][0]['gpus'], 1)
        self.assertEqual(spec['services'][0]['role'], 'sim')
        self.assertEqual(spec['timeoutMin'], 130)
        self.assertNotIn('mounts', spec)
        self.assertEqual(spec['volumeMounts'], [{'volume': 'workspace', 'target': '/task'}])
        binds = spec['services'][0]['binds']
        self.assertEqual({b['target'] for b in binds}, {'/adapter', '/upstream'})
        self.assertEqual(spec['services'][0]['entrypoint'], '/isaac-sim/python.sh')
        self.assertNotIn('docker', ' '.join(spec['services'][0]['command']))
        self.assertEqual(spec['hooks'][0]['service'], 'lab')


    def test_resolved_main_resources_are_honored_without_a_second_gpu(self):
        self.req['trial']['resources'] = {'cpus': 6, 'memGB': 12, 'gpus': 0, 'timeoutMin': 90}
        spec = adapter.solve(self.req)['spec']
        self.assertEqual(spec['resources'], {'cpus': 6, 'memGB': 12, 'gpus': 0})
        self.assertEqual(spec['timeoutMin'], 130)
        self.assertEqual(spec['services'][0]['gpus'], 1)
        self.req['trial']['resources']['gpus'] = 1
        with self.assertRaisesRegex(ValueError, 'simulator service'):
            adapter.solve(self.req)

    def test_shorter_timeout_requires_a_bounded_registration(self):
        self.assertIn('official', adapter.tasks(self.req))
        self.req['trial']['timeoutMin'] = 90
        with self.assertRaisesRegex(ValueError, 'explicit wallSeconds registration'):
            adapter.solve(self.req)
        self.assertFalse((self.root / 'staging').exists())
        for timeout in (130, 180):
            with self.subTest(timeout=timeout):
                self.req['trial']['timeoutMin'] = timeout
                reply = adapter.solve(self.req)
                self.assertEqual(reply['spec']['timeoutMin'], 130)
                self.assertEqual(reply['issues'], [])
                plan = json.loads((self.root / 'staging/plan.json').read_text())
                self.assertEqual(plan['wall_s'], plan['official_wall_s'])

    def test_smoke_is_labeled_and_has_no_official_aggregate(self):
        self.req['benchmark']['config']['wallSeconds'] = '120'
        self.assertNotIn('official', adapter.tasks(self.req))
        reply = adapter.solve(self.req)
        self.assertEqual(reply['spec']['timeoutMin'], 2)
        self.assertIn('Bounded smoke', reply['issues'][0])
        self.req['trial']['timeoutMin'] = 1
        reply = adapter.solve(self.req)
        self.assertEqual(reply['spec']['timeoutMin'], 1)
        self.assertIn('60s replaces native', reply['issues'][0])
        self.assertNotIn('official', adapter.tasks(self.req))
        self.req['benchmark']['config']['wallSeconds'] = '9000'
        with self.assertRaisesRegex(ValueError, 'official'):
            adapter.solve(self.req)

    def test_host_network_and_oracle_are_rejected(self):
        self.req['trial']['hostNetwork'] = True
        with self.assertRaisesRegex(ValueError, 'private simulator'):
            adapter.solve(self.req)
        self.req['trial']['hostNetwork'] = False
        self.req['trial']['method']['agent'] = 'oracle'
        with self.assertRaisesRegex(ValueError, 'reference oracle'):
            adapter.solve(self.req)

    def test_signed_capture_change_is_invalid(self):
        spec = adapter.solve(self.req)['spec']
        public = spec['services'][0]['env'][adapter.PUBLIC_KEY]
        evidence = self.root / 'evidence'
        evidence.mkdir()
        (evidence / 'instance.json').write_text('{"hidden":"explicit synthetic signature fixture"}')
        record = {'schema': 1, 'sha256': {'instance.json': verify.digest(evidence / 'instance.json')}}
        (evidence / 'result.json').write_text(json.dumps(record))
        helpers.sign_result(evidence, self.root / 'staging/evidence-private.pem')
        with patch.dict(os.environ, {adapter.PUBLIC_KEY: public}):
            self.assertEqual(verify.validate_seal(evidence), record)
            (evidence / 'instance.json').write_text('tampered')
            with self.assertRaisesRegex(ValueError, 'changed'):
                verify.validate_seal(evidence)

    def test_zero_is_valid_but_missing_verifier_is_invalid(self):
        out = self.root / 'verified'
        out.mkdir()
        self.req['verify'] = {'output': str(out)}
        self.assertTrue(adapter.score(self.req)['invalid'])
        plan = {k: self.req['trial'][k] for k in ('task', 'seed', 'method')}
        plan.update(wall_s=7800, official_wall_s=7800)
        (out / 'result.json').write_text(json.dumps({'valid': True, 'task_completed': False,
            'reward': 0, 'process_score': .4, 'plan': plan}))
        reply = adapter.score(self.req)
        self.assertFalse(reply['invalid'])
        self.assertEqual(reply['score'], 0)
        self.assertEqual(reply['metrics']['processScore'], 40)


    def test_long_native_call_returns_operation_without_holding_poll_lock(self):
        started, release = threading.Event(), threading.Event()
        class ExplicitWorkerDouble:
            def call(self, name, arguments):
                started.set()
                if not release.wait(2):
                    raise RuntimeError('Test did not release the explicit worker double')
                return {'state_id': 'test-state', 'value': 7}
        fake_envd = types.ModuleType('embodiedlab_sdk.envd')
        fake_envd._json_value = lambda value: value
        fake_sdk = types.ModuleType('embodiedlab_sdk')
        lab = service.Lab(ExplicitWorkerDouble(), {'wall_s': 60}, {'tools': [{'name': 'wait'}]})
        try:
            with patch.dict(sys.modules, {'embodiedlab_sdk': fake_sdk, 'embodiedlab_sdk.envd': fake_envd}), patch.object(service, 'ROOT', self.root):
                response = lab.call('wait', {'seconds': 1})
                self.assertEqual(response['status'], 'running')
                self.assertTrue(started.wait(1))
                with lab.lock:
                    self.assertEqual(lab.operations[response['id']]['status'], 'running')
                with self.assertRaisesRegex(ValueError, 'current operation'):
                    lab.call('wait', {})
                with self.assertRaises(PermissionError):
                    lab.call('get_hidden_truth', {})
                release.set()
                lab.executor.shutdown(wait=True)
                self.assertEqual(lab.operations[response['id']]['output']['result']['value'], 7)
        finally:
            release.set()
            lab.executor.shutdown(wait=True)


    def test_renderer_failure_is_not_overridden_by_native_ready_marker(self):
        private = self.root / 'native-worker'
        private.mkdir()
        (private / 'device.log').write_text(
            '[Error] [carb.scenerenderer-rtx.plugin] rtx driver verification failed.\n'
            '[Warning] [omni.hydra.rtx] HydraEngine rtx failed creating scene renderer.\n'
            'Simulation App Startup Complete\napp ready\nISAAC_NATIVE_READY\n')
        closed = []
        worker = types.SimpleNamespace(root=private, close=lambda: closed.append(True))
        evidence = self.root / 'evidence'
        with patch.object(service, 'ROOT', evidence):
            with self.assertRaisesRegex(RuntimeError, 'RTX renderer initialization failed'):
                service.validate_worker_startup(worker)
        self.assertEqual(closed, [True])
        self.assertEqual(json.loads((evidence / 'environment_error.json').read_text())['stage'], 'renderer_startup')
        self.assertTrue((evidence / 'captures/orbit-lab/diagnostics/startup-device.log').is_file())

    def test_private_finalization_rejects_agent_network_peer(self):
        class ExplicitHTTPException(Exception):
            def __init__(self, status, detail):
                self.status_code = status
        class ExplicitAppDouble:
            def __init__(self, **kwargs):
                self.routes = {}
            def get(self, path):
                return self.route(path)
            def post(self, path):
                return self.route(path)
            def route(self, path):
                def register(function):
                    self.routes[path] = function
                    return function
                return register
        fake_fastapi = types.ModuleType('fastapi')
        fake_fastapi.FastAPI = ExplicitAppDouble
        fake_fastapi.HTTPException = ExplicitHTTPException
        fake_fastapi.Request = object
        lab = types.SimpleNamespace(finalize=lambda: {'finalized': True})
        with patch.dict(sys.modules, {'fastapi': fake_fastapi}):
            app = service.make_app(lab)
        request = types.SimpleNamespace(client=types.SimpleNamespace(host='172.20.0.2'))
        with self.assertRaises(ExplicitHTTPException) as error:
            app.routes['/private/finalize'](request)
        self.assertEqual(error.exception.status_code, 403)
        request.client.host = '127.0.0.1'
        self.assertEqual(app.routes['/private/finalize'](request), {'finalized': True})
        self.assertNotIn('/v1/environments', app.routes)
        self.assertNotIn('/exec', app.routes)



    def test_finalize_drains_tools_and_failed_signing_stays_closed(self):
        spec = adapter.solve(self.req)['spec']
        public = spec['services'][0]['env'][adapter.PUBLIC_KEY]
        key = self.root / 'staging/evidence-private.pem'
        started, release, closed = threading.Event(), threading.Event(), threading.Event()
        class ExplicitWorkerDouble:
            def call(self, name, arguments):
                started.set()
                if not release.wait(2):
                    raise RuntimeError('Test did not release worker')
                return {'ok': True}
            def finalize(self):
                self.assert_released = release.is_set()
                return {'finalized': True}
            def close(self):
                closed.set()
        worker = ExplicitWorkerDouble()
        lab = service.Lab(worker, {'wall_s': 60}, {'tools': [{'name': 'wait'}]})
        fake_envd = types.ModuleType('embodiedlab_sdk.envd')
        fake_envd._json_value = lambda value: value
        fake_sdk = types.ModuleType('embodiedlab_sdk')
        evidence = self.root / 'capture'
        evidence.mkdir()
        nested = evidence / 'native/result.json'
        nested.parent.mkdir()
        nested.write_text('{"value": 1}')
        real_sign = helpers.sign_result
        failures = []
        def finish():
            try:
                lab.finalize()
            except Exception as exc:
                failures.append(exc)
        try:
            with patch.dict(sys.modules, {'embodiedlab_sdk': fake_sdk, 'embodiedlab_sdk.envd': fake_envd}), patch.object(service, 'ROOT', evidence):
                lab.call('wait', {})
                self.assertTrue(started.wait(1))
                with patch.object(helpers, 'sign_result', side_effect=RuntimeError('Explicit signing failure')):
                    thread = threading.Thread(target=finish)
                    thread.start()
                    deadline = time.monotonic() + 1
                    while not lab.finished and time.monotonic() < deadline:
                        threading.Event().wait(.01)
                    self.assertTrue(lab.finished)
                    with self.assertRaisesRegex(RuntimeError, 'closed'):
                        lab.call('wait', {})
                    self.assertFalse(closed.is_set())
                    release.set()
                    thread.join(2)
                    self.assertFalse(thread.is_alive())
                self.assertEqual(len(failures), 1)
                self.assertTrue(lab.finished)
                self.assertFalse(lab.finalized)
                self.assertTrue(worker.assert_released)
                with self.assertRaisesRegex(RuntimeError, 'closed'):
                    lab.call('wait', {})
                with patch.object(helpers, 'sign_result', side_effect=lambda root, ignored: real_sign(root, key)):
                    lab.finalize()
                self.assertTrue(lab.finalized)
                with patch.dict(os.environ, {adapter.PUBLIC_KEY: public}):
                    result = verify.validate_seal(evidence)
                self.assertEqual(set(result['sha256']), {'public-calls.jsonl', 'native/result.json'})
                nested.write_text('{"value": 2}')
                with patch.dict(os.environ, {adapter.PUBLIC_KEY: public}):
                    with self.assertRaisesRegex(ValueError, 'changed'):
                        verify.validate_seal(evidence)
        finally:
            release.set()
            lab.executor.shutdown(wait=True)


if __name__ == '__main__':
    unittest.main()
