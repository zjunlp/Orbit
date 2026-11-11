#!/usr/bin/env -S python3 -B
"""Pinned Cua Bench tasks on an Orbit-owned desktop service."""
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

from catalog import catalog
from evidence import COMMIT, DESKTOP_IMAGE, read, validate, write

# The shared adapter SDK (examples/sdk/orbit_bench): protocol entry point and score replies.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import main as protocol_main  # noqa: E402

HERE = Path(__file__).resolve().parent
CONFIG = {'image', 'maxSteps', 'agentDir'}


def checkout(root):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
    if git('rev-parse', 'HEAD') != COMMIT or git('status', '--porcelain', '--untracked-files=all'):
        raise ValueError(f'Use the clean Cua checkout at {COMMIT}')
    if not (root / 'cua_bench/runner/episode.py').is_file():
        raise ValueError('benchmark path must be the checkout libs/cua-bench directory')


def settings(req):
    c = req['benchmark']['config']
    if set(c) - CONFIG:
        raise ValueError('Unknown config: ' + ', '.join(sorted(set(c) - CONFIG)))
    steps = int(c.get('maxSteps', '20'))
    if not 1 <= steps <= 1000:
        raise ValueError('maxSteps must be 1..1000')
    root = Path(req['benchmark']['path']).resolve()
    checkout(root)
    return root, c, steps


IMMUTABLE = re.compile(r'(?:sha256:|[^\s]+@sha256:)[a-f0-9]{64}')


def readiness(c):
    if not IMMUTABLE.fullmatch(c.get('image', '')):
        return 'Register the client image by its immutable id: -c image=sha256:<id> (see README)'
    try:
        runtime = subprocess.check_output(['docker', 'info', '--format', '{{.DefaultRuntime}}'],
                                         text=True, stderr=subprocess.DEVNULL, timeout=10).strip()
        if runtime != 'runc':
            return 'The mapped desktop requires Docker default runtime runc'
        subprocess.check_output(['docker', 'image', 'inspect', c.get('image', 'orbit-cua-bench:2829e00b1'), DESKTOP_IMAGE],
                                stderr=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return 'Docker and the prepared Cua client/desktop images are required; see README'
    return None


def reason(row):
    if not row['path'].startswith('cua-bench-basic/'):
        return ('KiCad application setup and native netlist dependencies are not calibrated' if
                row['path'].startswith('cua-bench-kicad/') else
                'Workflow setup/evaluators require application-specific installation or accounts; not calibrated')
    config = (row['computer'] or {}).get('setup_config', {})
    if config.get('os_type') != 'linux' or config.get('image') != DESKTOP_IMAGE:
        return 'Only the original pinned Linux bench-web image is mapped'
    return None


def tasks(req):
    root, c, steps = settings(req)
    rows = catalog(root)
    unavailable = readiness(c)
    return {'tasks': [{'id': r['id'], 'title': r['title'], 'supported': not (unavailable or reason(r)),
                       'reason': unavailable or reason(r), 'tags': {'suite': r['path'].split('/')[0],
                       'variant': str(r['variant']), 'fidelity': 'experimental'}} for r in rows],
            'capabilities': {
                             'identity': {'id': 'cua-bench', 'name': 'Cua Bench'}, 'methods': ['external', 'empty', 'oracle'],
                'scoreKind': 'scalar', 'rescore': 'evidence', 'conditions': {
                    'Cua source': COMMIT, 'Desktop image': DESKTOP_IMAGE,
                    'Tasksets': 'Local datasets at the pinned source commit; not the older registry 1.0 revision',
                    'Execution': 'One task variant per trial; original run_episode; no hub queue or retries',
                    'Desktop runtime': 'Docker runc; upstream default entrypoint; shm=min(memory/2,2 GiB)',
                    'Display': 'Original image defaults; task dimensions passed to attach; no extra background/resolution override',
                    'Transport': 'Original cua-spacesd protocol over a per-Run network instead of host loopback',
                    'Observation/actions': 'Original Cua DesktopSession and selected native agent; oracle uses original solve hook',
                    'Step limit': f'{steps} by default; external method config.maxSteps can override', 'Seed': 'Trial seed initializes Python/NumPy; variant remains the native task index',
                    'Evidence': 'Live original evaluate hook; verify checks saved evidence, not environment replay',
                    'Coverage': 'All 145 variants listed; only 68 cua-bench-basic Linux variants mapped'}},
            'metrics': [{'name': 'score', 'label': 'Native reward', 'unit': '%', 'primary': True}]}


def solve(req):
    root, c, steps = settings(req)
    t = req['trial']
    if t.get('options') or t.get('hostNetwork'):
        raise ValueError('Trial options and host networking are not supported')
    unavailable = readiness(c)
    if unavailable:
        raise ValueError(unavailable)
    row = next((r for r in catalog(root) if r['id'] == t['task']), None)
    if row is None or reason(row):
        raise ValueError(reason(row) if row else 'Unknown task variant')
    m = t['method']
    if m['agent'] not in ('external', 'empty', 'oracle'):
        raise ValueError('Use external, empty or oracle')
    if set(m.get('config') or {}) - {'maxSteps'} or m.get('effort'):
        raise ValueError('Cua native config supports only maxSteps; effort is not supported')
    steps = int((m.get('config') or {}).get('maxSteps', steps))
    if not 1 <= steps <= 1000:
        raise ValueError('maxSteps must be 1..1000')
    if m['agent'] == 'external' and not re.fullmatch(r'[A-Za-z_]\w*(?:[.:-][A-Za-z_]\w*)*', m.get('entrypoint', '')):
        raise ValueError('external entrypoint must be a Cua registered agent or module:Class')
    resources = {'cpus': 1, 'memGB': 2, 'gpus': 0}
    resources.update({k: v for k, v in (t.get('resources') or {}).items() if k != 'timeoutMin'})
    if resources['gpus'] or resources.get('gpuIds') or resources.get('gpuMemGB'):
        raise ValueError('GPU policies are not supported by this adapter')
    stage = Path(t['staging'])
    stage.mkdir(parents=True, exist_ok=True)
    for name in ('runtime.py', 'evidence.py', 'trajectory.py'):
        shutil.copyfile(HERE / name, stage / name)
    plan = {'schema': 1, 'task': t['task'], 'seed': t['seed'], 'method': m, 'native': row,
            'max_steps': steps, 'commit': COMMIT, 'desktop_image': DESKTOP_IMAGE}
    write(stage / 'plan.json', plan)
    mounts = [{'source': str(stage), 'target': '/adapter', 'mode': 'ro'},
              {'source': str(root / 'cua_bench'), 'target': '/upstream/cua_bench', 'mode': 'ro'},
              {'source': str(root / 'datasets'), 'target': '/tasks', 'mode': 'ro'},
              {'source': str(root.parent / 'python/cua-sandbox/cua_sandbox'),
               'target': '/upstream/cua_sandbox', 'mode': 'ro'}]
    if m['agent'] == 'external' and 'agentDir' in c:
        path = Path(c['agentDir']).expanduser().resolve()
        if not path.is_dir():
            raise ValueError('agentDir must be a directory')
        mounts.append({'source': str(path), 'target': '/agent', 'mode': 'ro'})
    return {'spec': {'image': c.get('image', 'orbit-cua-bench:2829e00b1'),
                    'root': True, 'command': ['python', '/adapter/runtime.py', '/adapter/plan.json'],
                    'mounts': mounts, 'resources': resources, 'timeoutMin': t.get('timeoutMin') or 10,
                    'env': {'PYTHONPATH': '/upstream:/agent', 'PYTHONDONTWRITEBYTECODE': '1',
                            'CUA_HOME': '/tmp/cua', 'CUA_TELEMETRY_ENABLED': 'false'},
                    'network': True, 'networks': [{'name': 'gui', 'internal': False}],
                    'runNetworks': ['gui'], 'dependsOn': ['desktop'], 'volumes': ['desktop-token'],
                    'volumeMounts': [{'volume': 'desktop-token', 'target': '/run/cua', 'mode': 'ro'}],
                    'services': [{'name': 'desktop', 'image': DESKTOP_IMAGE,
                        'cpus': 2, 'memGB': 4, 'shmGB': 2, 'networks': ['gui'],
                        'env': {'CUA_ENV_AWAIT_TOKEN_FILE': '0'},
                        'volumes': [{'volume': 'desktop-token', 'target': '/run/cua', 'mode': 'rw'}],
                        'healthcheck': {'command': ['sh', '-c', 'test -s /run/cua/env-token'],
                                        'intervalSec': 2, 'timeoutSec': 2, 'retries': 60}}]}}


def verify(req):
    return {'spec': {'image': req['benchmark']['config'].get('image', 'orbit-cua-bench:2829e00b1'),
                    'command': ['python', '/validator/evidence.py', '/solve'], 'network': False,
                    'resources': {'cpus': 1, 'memGB': 1, 'gpus': 0}, 'timeoutMin': 1,
                    'mounts': [{'source': str(HERE / 'evidence.py'), 'target': '/validator/evidence.py', 'mode': 'ro'},
                               {'source': req['solve']['output'], 'target': '/solve', 'mode': 'ro'}]}}


def score(req):
    review = {'files': [{'label': 'Original episode', 'phase': 'solve', 'path': 'result.json', 'kind': 'json'},
                       {'label': 'Native ATIF', 'phase': 'solve', 'path': 'native/trajectory.json', 'kind': 'json'},
                       {'label': 'Validation', 'phase': 'verify', 'path': 'validation.json', 'kind': 'json'}]}
    try:
        output = Path(req['solve']['output'])
        if (output / 'trajectory-review.json').is_file():
            review['files'].insert(0, {'label': 'Native desktop frames', 'phase': 'solve',
                'path': 'trajectory-review.json', 'kind': 'trajectory', 'fallback': 'json'})
        result = validate(output)
        if result != read(Path(req['verify']['output']) / 'validation.json'):
            raise ValueError('Verifier disagrees with captured evidence')
        plan = read(output / 'plan.json')
        if any(plan[k] != req['trial'][k] for k in ('task', 'seed', 'method')):
            raise ValueError('Evidence belongs to a different trial')
        return {**result, 'review': review}
    except (OSError, ValueError, KeyError, TypeError) as error:
        return {'score': None, 'maxScore': 1, 'invalid': True, 'failure': 'scorer_error',
                'issues': [f'Cua evidence: {error}'], 'review': review}


if __name__ == "__main__":
    sys.exit(protocol_main(tasks, solve, verify, score))
