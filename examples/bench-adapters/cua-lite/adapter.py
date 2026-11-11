#!/usr/bin/env -S python3 -B
"""Pinned CUA-Lite native browser environments, one episode per Orbit trial."""
import json
from importlib import import_module
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

from evidence import COMMIT, MINIWOB_COMMIT, read, validate, write
from web_suites import ONLINE_BUILD_VERSIONS, ONLINE_SOURCE_LAYOUT, WEB_SUITES, suite_for

# The shared adapter SDK (examples/sdk/orbit_bench): protocol entry point and score replies.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import main as protocol_main  # noqa: E402

HERE = Path(__file__).resolve().parent
sys.path.append(str(HERE.parents[1] / 'tools'))
gui_adapter = import_module('orbit-gui-service.adapter')
gui_evidence = import_module('orbit-gui-service.evidence')
CLI_TASKS = {'click-test', 'click-button', 'click-dialog', 'enter-text', 'choose-list', 'click-checkboxes'}


def is_cli(req):
    return req['trial']['method']['agent'] not in ('empty', 'external', 'oracle', 'policy')

TASKS = set(read(HERE / 'miniwob_tasks.json')['tasks'])
CONFIG = {'image', 'miniwob', 'maxSteps', 'webVoyagerMaxSteps', 'onlineMind2WebMaxSteps', 'agentDir',
          'webVoyagerImage', 'onlineMind2WebImage'}
OTHER_SUITES = ['osworld', 'osworld_v2', 'windowsarena', 'cua.basic', 'cua.kicad', 'cua.workflows',
                'androidworld', 'androidlab', 'mobileworld', 'mobilegym',
                'browsergym.webarena', 'browsergym.visualwebarena', 'webgym', 'osworld_g', 'screenspot_pro']


def checkout(root, revision):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
    if git('rev-parse', 'HEAD') != revision or git('status', '--porcelain', '--untracked-files=all'):
        raise ValueError(f'Expected a clean checkout at {revision}')


def settings(req):
    c = req['benchmark']['config']
    if set(c) - CONFIG:
        raise ValueError('Unknown config: ' + ', '.join(sorted(set(c) - CONFIG)))
    root = Path(req['benchmark']['path']).resolve()
    checkout(root, COMMIT)
    if not (root / 'lite/gym/envs/browsergym/main.py').is_file():
        raise ValueError('Expected a CUA-Lite source checkout')
    steps = int(c.get('maxSteps', '10'))
    if not 1 <= steps <= 1000:
        raise ValueError('maxSteps must be 1..1000')
    return root, c, steps


IMMUTABLE = re.compile(r'(?:sha256:|[^\s]+@sha256:)[a-f0-9]{64}')


def readiness(c):
    if not IMMUTABLE.fullmatch(c.get('image', '')):
        return 'Register the client image by its immutable id: -c image=sha256:<id> (see README)'
    try:
        subprocess.check_output(['docker', 'image', 'inspect', c.get('image', 'orbit-cua-lite:2af6926')],
                                stderr=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return 'Docker and the prepared CUA-Lite client image are required; see README'
    return None


def web_readiness(c, suite):
    image = c.get(WEB_SUITES[suite]['image'], '')
    if not re.fullmatch(r'(?:sha256:|[^\s]+@sha256:)[a-f0-9]{64}', image):
        return f"Register an immutable {WEB_SUITES[suite]['image']} built from the native backend; see README"
    try:
        details = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image],
            stderr=subprocess.DEVNULL, timeout=10))[0]
        labels = details.get('Config', {}).get('Labels') or {}
        if labels.get('orbit.cua-lite.source') != COMMIT or labels.get('orbit.cua-lite.suite') != suite:
            return 'Backend image lacks matching pinned source/suite labels; use prepare_backend.py'
        if suite == 'online_mind2web' and any(labels.get('orbit.cua-lite.' + name) != version
                                             for name, version in ONLINE_BUILD_VERSIONS.items()):
            return 'Backend image lacks matching fixed dependency labels; use prepare_backend.py'
        if suite == 'online_mind2web' and labels.get('orbit.cua-lite.source-layout') != ONLINE_SOURCE_LAYOUT:
            return 'Backend image lacks the recorded Online-Mind2Web source layout; use prepare_backend.py'
    except (OSError, ValueError, KeyError, IndexError, subprocess.SubprocessError):
        return 'The pinned native browser backend image is not prepared locally'
    return readiness(c)


def miniwob(c):
    if 'miniwob' not in c:
        raise ValueError('Register -c miniwob=/path/to/the/fixed/miniwob-plusplus checkout')
    root = Path(c['miniwob']).expanduser().resolve()
    checkout(root, MINIWOB_COMMIT)
    if not (root / 'miniwob/html/miniwob').is_dir():
        raise ValueError('MiniWoB HTML is missing')
    return root


def tasks(req):
    root, c, steps = settings(req)
    try:
        mini = miniwob(c)
        missing = {t for t in TASKS if not (mini / 'miniwob/html/miniwob' / f'{t}.html').is_file()}
        problem = readiness(c)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        missing, problem = set(), str(error)
    rows = [{'id': f'browsergym.miniwob@{t}', 'title': t,
             'supported': problem is None and t not in missing,
             'reason': problem or ('Original MiniWoB HTML is missing' if t in missing else None),
             'tags': {'suite': 'browsergym.miniwob', 'fidelity': 'experimental'}} for t in sorted(TASKS)]
    for suite, detail in WEB_SUITES.items():
        problem = web_readiness(c, suite)
        for key, task in read(root / 'lite/gym/envs' / detail['path'] / 'data/tasks.json').items():
            reason = ('Outside the explicitly reviewed read-only, login-free task subset'
                      if key not in detail['tasks'] else problem)
            rows.append({'id': f'{suite}@{key}', 'title': task.get('instruction') or task.get('confirmed_task'),
                'supported': reason is None, 'reason': reason,
                'tags': {'suite': suite, 'fidelity': 'experimental' if reason is None else 'unsupported'}})
    for suite in OTHER_SUITES:
        reason = ('Requires an isolated website backend or a static grounding adapter' if suite in
                  ('browsergym.webarena', 'browsergym.visualwebarena', 'webgym', 'osworld_g', 'screenspot_pro') else
                  'Desktop/mobile native lifecycle is not mapped; KVM is outside the Orbit ledger and requires host exclusivity')
        if suite not in ('browsergym.webarena', 'browsergym.visualwebarena', 'webgym', 'osworld_g', 'screenspot_pro'):
            if not Path('/dev/kvm').exists():
                reason += '; /dev/kvm does not exist'
            elif not os.access('/dev/kvm', os.R_OK | os.W_OK):
                reason += '; /dev/kvm is not readable/writable'
        rows.append({'id': f'suite:{suite}', 'title': f'{suite} (suite availability, not an episode)',
                     'supported': False, 'reason': reason, 'tags': {'suite': suite, 'rowKind': 'suite'}})
    return {'tasks': rows, 'capabilities': {
                                        'identity': {'id': 'cua-lite', 'name': 'CUA-Lite collection', 'version': COMMIT}, 'methods': ['external', 'empty', 'cli'], 'requires': ['gui'],
        'scoreKind': 'binary',
        'rescore': 'none' if any(c.get(s['image']) for s in WEB_SUITES.values()) else 'evidence',
        'conditions': {
            'CLI instructions': gui_adapter.CLI_TEMPLATE,
            'CLI route': 'CLI Agent via Orbit GUI service; observations are screenshots only',
            'CLI subset': ', '.join(sorted(CLI_TASKS)),
            'CLI web suites': 'Unsupported for WebVoyager / Online-Mind2Web; external and empty unchanged',
            'CUA-Lite source': COMMIT, 'BrowserGym': '0.14.3', 'MiniWoB source': MINIWOB_COMMIT,
            'Execution': 'One native environment episode per trial; no rollout queue, retries or result-directory resume',
            'Observation': 'Original screenshot-first CUA-Lite defaults, including cursor overlay; no DOM/a11y override',
            'Actions': 'Original canonical Lite tool calls; normalized coordinates [0,1000]',
            'Step limit': str(steps), 'Native MiniWoB timeout': 'CUA-Lite default 30 seconds (upstream page default is 5 seconds)', 'Seed': 'Orbit trial seed forwarded to native environment; live websites are not seeded',
            'Isolation': 'Private container and loopback MiniWoB HTTP server; no host singleton',
            'Web backends': 'One original browser service per trial; instances=1; immutable image IDs recorded in solve plan',
            'WebVoyager image': c.get('webVoyagerImage', 'not prepared'),
            'Online-Mind2Web image': c.get('onlineMind2WebImage', 'not prepared'),
            'Online-Mind2Web build dependencies': ', '.join(f'{name}=={v}' for name, v in ONLINE_BUILD_VERSIONS.items()),
            'Online-Mind2Web source layout': 'Fixed original root files/src/script; unused reference data/images excluded',
            'Web evaluation': 'Original terminal judge deferred to after phase; no judge key or terminal reward given to the policy',
            'Web rescore': 'Current Orbit does not rescore after-phase trials; use a separate MiniWoB registration for evidence rescore',
            'Web judges': 'Native gpt-4.1 / o4-mini; OPENAI_API_KEY via benchmark passEnv; image_judge_workers=1',
            'Web step limits': f"WebVoyager {c.get('webVoyagerMaxSteps', '15')}; Online-Mind2Web {c.get('onlineMind2WebMaxSteps', '30')}",
            'Deviation: WebVoyager no-answer': 'The original judge returns None (no_agent_response) when the agent gives no answer; Orbit records a valid 0 (the agent produced nothing to judge)',
            'Web subset': 'Five reviewed read-only tasks per suite; live-site availability is checked during reset',
            'Unsupported suites': 'Explicit suite rows are availability records, not individual benchmark episodes',
            'KVM': 'Not in Orbit ledger; desktop/mobile suites refused; host exclusivity required',
            'Evidence': 'Native MiniWoB reward or deferred original Web judge; offline verify checks saved evidence only'}},
        'metrics': [{'name': 'score', 'label': 'Native success', 'unit': '%', 'primary': True}]}


def solve(req):
    root, c, steps = settings(req)
    t, m = req['trial'], req['trial']['method']
    suite = suite_for(t['task'])
    web = WEB_SUITES.get(suite)
    if is_cli(req) and (web or t['task'].split('@', 1)[-1] not in CLI_TASKS):
        raise ValueError('CLI unsupported: only the calibrated CUA-Lite MiniWoB subset is enabled; WebVoyager / Online-Mind2Web need a separate bridge calibration')
    mini = None if web else miniwob(c)
    unavailable = readiness(c)
    if unavailable:
        raise ValueError(unavailable)
    if web:
        if t['task'].split('@', 1)[-1] not in web['tasks']:
            raise ValueError('Task is outside the reviewed login-free web subset')
        if issue := web_readiness(c, suite):
            raise ValueError(issue)
        key = 'webVoyagerMaxSteps' if suite == 'webharbor.webvoyager' else 'onlineMind2WebMaxSteps'
        steps = int(c.get(key, str(web['steps'])))
        if not 1 <= steps <= 1000:
            raise ValueError(f'{key} must be 1..1000')
    elif t['task'] not in {f'browsergym.miniwob@{name}' for name in TASKS}:
        raise ValueError('Only registered MiniWoB or reviewed web episodes are supported')
    if t.get('options') or t.get('hostNetwork'):
        raise ValueError('Trial options and host networking are not supported')
    if m['agent'] in ('oracle', 'policy'):
        raise ValueError('Use CLI, external or empty; there is no generic MiniWoB oracle')
    if not is_cli(req) and m.get('effort'):
        raise ValueError('CUA-Lite does not define a common effort setting; use native method config')
    if m['agent'] == 'external' and not re.fullmatch(r'[A-Za-z0-9_@.:-]+', m.get('entrypoint', '')):
        raise ValueError('Use a native agent id or module:factory entrypoint')
    resources = {'cpus': 2, 'memGB': 4, 'gpus': 0}
    resources.update({k: v for k, v in (t.get('resources') or {}).items() if k != 'timeoutMin'})
    if resources['gpus'] or resources.get('gpuIds') or resources.get('gpuMemGB'):
        raise ValueError('This adapter supports CPU browser environments and remote models only')
    stage = Path(t['staging'])
    stage.mkdir(parents=True, exist_ok=True)
    if is_cli(req):
        return cli_solve(req, root, mini, c, resources, stage, steps)
    for file in ('runtime.py', 'evidence.py', 'web_suites.py', 'judge.py'):
        shutil.copyfile(HERE / file, stage / file)
    write(stage / 'plan.json', {'schema': 1, 'commit': COMMIT, 'miniwob_commit': MINIWOB_COMMIT,
        'task': t['task'], 'seed': t['seed'], 'method': m, 'max_steps': steps,
        **({'deferred_judge': True, 'backend_image': c[web['image']]} if web else {})})
    mounts = [{'source': str(stage), 'target': '/adapter', 'mode': 'ro'},
              {'source': str(root / 'lite'), 'target': '/upstream/lite', 'mode': 'ro'},
              {'source': str(root / 'pyproject.toml'), 'target': '/upstream/pyproject.toml', 'mode': 'ro'}]
    if mini is not None:
        mounts.append({'source': str(mini / 'miniwob/html'), 'target': '/miniwob', 'mode': 'ro'})
    if m['agent'] == 'external' and 'agentDir' in c:
        path = Path(c['agentDir']).expanduser().resolve()
        if not path.is_dir():
            raise ValueError('agentDir must be a directory')
        mounts.append({'source': str(path), 'target': '/agent', 'mode': 'ro'})
    spec = {'image': c.get('image', 'orbit-cua-lite:2af6926'),
        'command': ['python', '/adapter/runtime.py', '/adapter/plan.json'], 'mounts': mounts,
        'resources': resources, 'timeoutMin': t.get('timeoutMin') or 5,
        'network': m['agent'] == 'external', 'env': {'PYTHONPATH': '/upstream:/agent',
            'PYTHONDONTWRITEBYTECODE': '1', 'BROWSERGYM_CACHE': '/tmp/lite-browsergym',
            'MINIWOB_PORT': '7560', 'MINIWOB_URL': 'http://127.0.0.1:7560/miniwob/'}}
    if web:
        prefix = web['prefix']
        spec['env'] = {'PYTHONPATH': '/upstream:/agent', 'PYTHONDONTWRITEBYTECODE': '1',
                       f'{prefix}_RPC_URL': 'http://browser:8000'}
        spec.update(network=True, networks=[{'name': 'browser', 'internal': True}],
            runNetworks=['default', 'browser'], dependsOn=['browser'],
            after={'command': ['python', '/adapter/judge.py'], 'timeoutMin': 30, 'network': True},
            services=[{'name': 'browser', 'image': c[web['image']],
                'cpus': 2, 'memGB': 4, 'shmGB': 1, 'init': True,
                'networks': ['default', 'browser'] if suite == 'online_mind2web' else ['browser'],
                'env': {f'{prefix}_INSTANCES': '1'},
                'healthcheck': {'command': ['python', '-c',
                    "import json,urllib.request; assert json.load(urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=3))['ok']"],
                    'intervalSec': 2, 'timeoutSec': 5, 'startPeriodSec': 120, 'retries': 15}}])
    return {'spec': spec}


def cli_solve(req, root, mini, config, resources, stage, steps):
    trial = req['trial']
    shutil.copyfile(HERE / 'server.py', stage / 'server.py')
    gui_adapter.stage_shared(stage)
    plan = {'schema': 1, 'backend': 'cua-lite', 'browsergym_version': '0.14.3',
        'commit': COMMIT, 'miniwob_commit': MINIWOB_COMMIT, 'action_set': 'canonical',
        'task': trial['task'], 'seed': trial['seed'], 'method': trial['method'], 'max_steps': steps}
    return gui_adapter.cli_spec(trial, config.get('image', 'orbit-cua-lite:2af6926'), resources,
        stage, plan, [{'source': str(root / 'lite'), 'target': '/upstream/lite', 'mode': 'ro'},
                      {'source': str(root / 'pyproject.toml'), 'target': '/upstream/pyproject.toml', 'mode': 'ro'},
                      {'source': str(mini / 'miniwob/html'), 'target': '/miniwob', 'mode': 'ro'}],
        {'PYTHONPATH': '/upstream', 'BROWSERGYM_CACHE': '/tmp/lite-browsergym',
         'MINIWOB_PORT': '7560', 'MINIWOB_URL': 'http://127.0.0.1:7560/miniwob/'},
        gui_adapter.instruction('CUA-Lite MiniWoB', trial['task']))


def cli_score(req):
    prefix = 'services/gui/evidence/'
    output = Path(req['solve']['output']) / prefix
    review = {'files': [
        {'label': 'GUI trajectory', 'phase': 'solve', 'path': prefix + 'trajectory-review.json', 'kind': 'trajectory', 'fallback': 'json'},
        {'label': 'Native observations/actions', 'phase': 'solve', 'path': prefix + 'trajectory.jsonl', 'kind': 'text'},
        {'label': 'Native result', 'phase': 'solve', 'path': prefix + 'result.json', 'kind': 'json'},
        {'label': 'Evidence validation', 'phase': 'verify', 'path': 'validation.json', 'kind': 'json'}]}
    try:
        report = gui_evidence.validate(output, gui_adapter.trusted_public_key(req))
        if report != read(Path(req['verify']['output']) / 'validation.json'):
            raise ValueError('Verifier disagrees with signed service evidence')
        plan, result = read(output / 'plan.json'), read(output / 'result.json')
        if any(plan[k] != req['trial'][k] for k in ('task', 'seed', 'method')):
            raise ValueError('Evidence belongs to another trial')
        final = json.loads((output / 'trajectory.jsonl').read_text().splitlines()[-1])
        review['details'] = {'environment': 'CUA-Lite ' + COMMIT, 'observation': 'screenshot',
            'action_set': 'canonical tool calls, normalized [0,1000]', 'steps': str(report['steps']),
            'evaluation': 'Native reward; signed service evidence verification'}
        return {'score': report['reward'], 'maxScore': 1, 'invalid': False, 'issues': [],
            'review': review, 'episode': {'steps': report['steps'], 'terminated': final['terminated'],
                'truncated': final['truncated'], 'endedBy': result['stop_reason'],
                'successSignal': 'original CUA-Lite terminal reward'}}
    except (OSError, ValueError, KeyError, TypeError) as error:
        return {'score': None, 'maxScore': 1, 'invalid': True, 'failure': 'scorer_error',
            'issues': [f'CUA-Lite service evidence: {error}'], 'review': review}


def verify(req):
    if is_cli(req):
        return {'spec': {'image': req['benchmark']['config'].get('image', 'orbit-cua-lite:2af6926'),
            'command': ['python', '/validator/evidence.py', '/solve'], 'network': False,
            'env': {gui_evidence.PUBLIC_KEY_ENV: gui_adapter.trusted_public_key(req)},
            'resources': {'cpus': 1, 'memGB': 1, 'gpus': 0}, 'timeoutMin': 1,
            'mounts': [{'source': str(gui_adapter.HERE / 'evidence.py'), 'target': '/validator/evidence.py', 'mode': 'ro'},
                       {'source': str(Path(req['solve']['output']) / 'services/gui/evidence'), 'target': '/solve', 'mode': 'ro'}]}}
    return {'spec': {'image': req['benchmark']['config'].get('image', 'orbit-cua-lite:2af6926'),
        'command': ['python', '/validator/evidence.py', '/solve'], 'network': False,
        'resources': {'cpus': 1, 'memGB': 1, 'gpus': 0}, 'timeoutMin': 1,
        'mounts': [{'source': str(HERE / 'evidence.py'), 'target': '/validator/evidence.py', 'mode': 'ro'},
                   {'source': req['solve']['output'], 'target': '/solve', 'mode': 'ro'}]}}


def score(req):
    if is_cli(req):
        return cli_score(req)
    review = {'files': [{'label': 'Native observations/actions', 'phase': 'solve', 'path': 'events.jsonl', 'kind': 'text'},
        {'label': 'Native result', 'phase': 'solve', 'path': 'result.json', 'kind': 'json'},
        {'label': 'Evidence validation', 'phase': 'verify', 'path': 'validation.json', 'kind': 'json'}]}
    output = Path(req['solve']['output'])
    if (output / 'trajectory-review.json').is_file():
        review['files'].insert(0, {'label': 'GUI trajectory', 'phase': 'solve', 'path': 'trajectory-review.json',
                                  'kind': 'trajectory', 'fallback': 'json'})
    if (output / 'judge-result.json').is_file():
        review['files'].append({'label': 'Native terminal judge', 'phase': 'solve',
                                'path': 'judge-result.json', 'kind': 'json'})
    try:
        report = validate(output)
        if report != read(Path(req['verify']['output']) / 'validation.json'):
            raise ValueError('Verifier disagrees with saved evidence')
        plan = read(output / 'plan.json')
        if any(plan[k] != req['trial'][k] for k in ('task', 'seed', 'method')):
            raise ValueError('Evidence belongs to another trial')
        return {**report, 'review': review}
    except (OSError, ValueError, KeyError, TypeError) as error:
        return {'score': None, 'maxScore': 1, 'invalid': True, 'failure': 'scorer_error',
                'issues': [f'CUA-Lite evidence: {error}'], 'review': review}


if __name__ == "__main__":
    sys.exit(protocol_main(tasks, solve, verify, score))
