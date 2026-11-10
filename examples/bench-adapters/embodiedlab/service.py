"""Restricted transport for native public tools; Orbit owns service lifecycle and leases."""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import threading
import time
import urllib.request
import uuid

ROOT = Path('/evidence')
WORKSPACE = Path('/agent-workspace')
ENVIRONMENT = 'orbit-lab'
URL = 'http://lab:8765'


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False))


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


class Lab:
    def __init__(self, worker, plan, native):
        self.worker = worker
        self.plan = plan
        self.native = native
        self.lock = threading.RLock()
        self.operations = OrderedDict()
        self.execution_lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=1)
        self.allowed = {t['name'] for t in native['tools']}
        self.deadline = time.monotonic() + plan['wall_s']
        self.finished = False
        self.finalized = False

    def call(self, name, arguments):
        if name not in self.allowed:
            raise PermissionError('Tool is not available at the fixed T0 exposure')
        if not isinstance(arguments, dict):
            raise ValueError('Tool arguments must be an object')
        with self.lock:
            if self.finished or time.monotonic() >= self.deadline:
                raise RuntimeError('The trial is closed')
            if any(op['status'] == 'running' for op in self.operations.values()):
                raise ValueError('Wait for the current operation before the next public tool call')
            operation = {'id': uuid.uuid4().hex, 'status': 'running'}
            self.operations[operation['id']] = operation
            while len(self.operations) > 128:
                self.operations.popitem(last=False)
            self.executor.submit(self.invoke, operation['id'], name, arguments)
            return dict(operation)

    def invoke(self, operation_id, name, arguments):
        with self.execution_lock:
            with self.lock:
                if self.finished:
                    self.operations[operation_id].update(status='failed', error={'message': 'The trial is closed'})
                    return
            operation = {'id': operation_id, 'status': 'completed'}
            try:
                from embodiedlab_sdk.envd import _json_value
                value = self.worker.call(name, arguments)
                images = None
                if isinstance(value, dict) and '__embodiedlab_tool_result__' in value:
                    images = value.get('__embodiedlab_tool_images__')
                    value = value['__embodiedlab_tool_result__']
                output = {'ok': True, 'result': _json_value(value)}
                if images:
                    output['tool_images'] = _json_value(images)
                operation['output'] = output
            except Exception as exc:
                operation['status'] = 'failed'
                operation['error'] = {'type': type(exc).__name__, 'message': str(exc)}
            with self.lock:
                self.operations[operation_id] = operation
                with (ROOT / 'public-calls.jsonl').open('a') as stream:
                    stream.write(json.dumps({'name': name, 'arguments': arguments,
                                             'status': operation['status'], 'id': operation_id}) + '\n')

    def finalize(self):
        from evidence_helpers import sign_result
        with self.lock:
            self.finished = True
        with self.execution_lock, self.lock:
            if self.finalized:
                return {'finalized': True}
            closed = 'wall_limit' if time.monotonic() >= self.deadline else 'agent_stop'
            capture = self.worker.finalize()
            self.worker.close()
            excluded = {'result.json', 'evidence-signature.json'}
            result = {'schema': 1, 'plan': self.plan, 'capture': capture, 'close_reason': closed,
                      'sha256': {p.relative_to(ROOT).as_posix(): digest(p)
                                 for p in sorted(ROOT.rglob('*')) if p.is_file()
                                 and p.relative_to(ROOT).as_posix() not in excluded}}
            write(ROOT / 'result.json', result)
            sign_result(ROOT, '/adapter/evidence-private.pem')
            self.finalized = True
            return {'finalized': True}


def prepare():
    from benchmark.instances import snapshot
    from benchmark.instances.service import derive, materialize
    from benchmark.registry.loader import load
    from scripts import trial as native
    plan = json.loads(Path('/adapter/plan.json').read_text())
    ROOT.mkdir(parents=True, exist_ok=True)
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    instance = derive(plan['task'], 'dev', plan['seed'])
    spec = load(plan['task'])
    if spec.budget['sim_s'] != plan['sim_s'] or spec.budget['wall_s'] != plan['official_wall_s']:
        raise ValueError('Pinned native task budget disagrees with plan')
    instances = Path('/var/lib/embodiedlab/instances')
    materialize(instance, instances)
    snapshot.save(instance, ROOT)
    os.environ.update(EMBODIEDLAB_TASK_ID=plan['task'], EMBODIEDLAB_INSTANCE_ID=instance.instance_id,
                      EMBODIEDLAB_EXPOSURE='T0', EMBODIEDLAB_VIEWER='off', EMBODIEDLAB_SEED='0',
                      EMBODIEDLAB_MAX_STEPS=str(int(plan['sim_s'] * 30)),
                      EMBODIEDLAB_CAPTURE_DIR=str(ROOT / 'captures' / ENVIRONMENT))
    from embodiedlab_sdk.robot.embodiedlab.bootstrap import Worker, catalog, exposed
    worker = Worker()
    task = worker.call('get_task_spec', {})
    if task.get('exposure') != 'T0':
        worker.close()
        raise ValueError('Native exposure filter did not enforce T0')
    tools = [{k: t.get(k) for k in ('name', 'signature', 'description', 'effect')}
             for t in catalog(worker.task['task_id'], worker.task) if exposed(t['name'], worker.task)]
    write(WORKSPACE / 'task_spec.json', task)
    write(ROOT / 'workspace/task_spec.json', task)
    write(WORKSPACE / 'tools.json', tools)
    write(WORKSPACE / 'env.json', {'environment_id': ENVIRONMENT, 'controller': URL, 'exp_id': plan['task'], 'exposure': 'T0'})
    (WORKSPACE / 'task_card.md').write_text(native._task_card(task))
    (WORKSPACE / 'README.md').write_text(native.README.format(environment_id=ENVIRONMENT, controller=URL,
        exp_id=plan['task'], exposure='T0', exposure_note=native.EXPOSURE_NOTES['T0'],
        tool_table=native._tool_table(tools), sim_s=plan['sim_s'], wall_min=round(plan['wall_s'] / 60, 1),
        manipulation_note=native.manipulation_note('T0', task)))
    (WORKSPACE / 'PROMPT.md').write_text(native.PROMPT.format(workspace='/task', exposure='T0', exposure_note=native.EXPOSURE_NOTES['T0']))
    (WORKSPACE / 'NOTES.md').write_text('# Notes\n')
    (WORKSPACE / 'images').mkdir(exist_ok=True)
    (WORKSPACE / 'tools').mkdir(exist_ok=True)
    shutil.copytree('/upstream/sdk/src/embodiedlab_api', WORKSPACE / 'embodiedlab_api',
                    ignore=shutil.ignore_patterns('__pycache__'), dirs_exist_ok=True)
    native._write_wrapper(WORKSPACE, '/opt/venv/bin/python')
    for path in (WORKSPACE, *WORKSPACE.rglob('*')):
        path.chmod(0o777 if path.is_dir() or path.name == 'py' else 0o666)
    write(ROOT / 'plan.json', plan)
    lab = Lab(worker, plan, {'tools': tools})
    return lab


def make_app(lab):
    from fastapi import FastAPI, HTTPException, Request
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.get('/ready')
    def ready():
        return {'ready': True}

    @app.get('/v1/tools')
    def tools(environment_id: str):
        if environment_id != ENVIRONMENT:
            raise HTTPException(404, 'Unknown environment')
        return lab.native['tools']

    @app.post('/v1/tools/call')
    async def call(request: Request):
        body = await request.body()
        if len(body) > 4 * 1024 * 1024:
            raise HTTPException(413, 'Call is too large')
        try:
            value = json.loads(body)
            if value.get('environment_id') != ENVIRONMENT:
                raise ValueError('Unknown environment')
            return lab.call(value['name'], value.get('arguments', {}))
        except (KeyError, TypeError, ValueError, PermissionError, RuntimeError) as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.get('/v1/operations/{operation_id}')
    def operation(operation_id: str):
        with lab.lock:
            if operation_id not in lab.operations:
                raise HTTPException(404, 'Unknown operation')
            return lab.operations[operation_id]

    @app.post('/private/finalize')
    def finalize(request: Request):
        if request.client.host != '127.0.0.1':
            raise HTTPException(403, 'Lifecycle is private to this service')
        return lab.finalize()

    return app


def main():
    command = sys.argv[1]
    if command in ('ready', 'finalize'):
        path = '/ready' if command == 'ready' else '/private/finalize'
        req = urllib.request.Request('http://127.0.0.1:8765' + path,
                                     data=None if command == 'ready' else b'{}')
        with urllib.request.urlopen(req, timeout=1170 if command == 'finalize' else 2) as response:
            response.read()
        return
    if command != 'serve':
        raise ValueError('Unknown command')
    import uvicorn
    lab = prepare()
    timer = threading.Timer(lab.plan['wall_s'], lab.finalize)
    timer.daemon = True
    timer.start()
    try:
        uvicorn.run(make_app(lab), host='0.0.0.0', port=8765, log_level='warning')
    finally:
        timer.cancel()
        lab.finalize()


if __name__ == '__main__':
    main()
