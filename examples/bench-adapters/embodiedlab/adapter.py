#!/usr/bin/env -S python3 -B
"""EmbodiedLab native T0 experiments through Orbit's Agent CLI and GPU service."""
import base64
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / 'sdk'))
from orbit_bench import main as protocol_main

CATALOG = json.loads((HERE / 'catalog.json').read_text())
COMMIT = CATALOG['commit']
TASKS = {r['id']: r for r in CATALOG['experiments']}
PUBLIC_KEY = 'ORBIT_EMBODIEDLAB_EVIDENCE_PUBLIC_KEY'
CONFIG = {'image', 'labImage', 'exposure', 'wallSeconds'}


def settings(req):
    root = Path(req['benchmark']['path']).resolve()
    config = req['benchmark']['config']
    if set(config) - CONFIG:
        raise ValueError('Unknown EmbodiedLab configuration: ' + ', '.join(sorted(set(config) - CONFIG)))
    if config.get('exposure', 'T0') != 'T0':
        raise ValueError('Only native T0 is integrated. T1 requires SAM3/cuRobo services; T2 is unreleased.')
    if not (root / 'scripts/trial.py').is_file():
        raise ValueError('Expected the official EmbodiedLab checkout')
    return root, config


def revision(root):
    head = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    dirty = subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain', '--untracked-files=no'], text=True)
    if head != COMMIT or dirty:
        raise ValueError(f'Use the unmodified EmbodiedLab checkout at {COMMIT}')


def tasks(req):
    root, config = settings(req)
    revision(root)
    return {'tasks': [{'id': r['id'], 'title': r['title'], 'supported': True, 'reason': None,
                      'tags': {'discipline': r['kit'], 'tier': r['tier'], 'exposure': 'T0'}}
                     for r in TASKS.values()],
            'capabilities': {'identity': {'id': 'embodiedlab', 'name': 'EmbodiedLab', 'version': COMMIT, 'variant': 'T0'},
                'taxonomy': {'domains': ['science', 'robotics'], 'taskTypes': ['experimentation', 'analysis', 'manipulation'],
                    'targets': ['knowledge', 'tool-use', 'control'], 'modalities': ['text', 'image', 'structured-data'],
                    'interfaces': ['terminal', 'file-edit', 'physical-control'], 'platforms': ['simulation'],
                    'world': ['controlled'], 'feedback': ['step'], 'scoringEvidence': ['artifact', 'trajectory'],
                    'scoringMethods': ['rule-check']},
                'methods': ['cli', 'empty'], 'scoreKind': 'binary', 'rescore': 'evidence',
                'conditions': {'Interface': 'T0: RGB, raw control, kinematics; no SAM3/cuRobo',
                    'Evaluation target': 'Model + coding-agent harness + scientific experimentation',
                    'Split': 'Native deterministic dev instances, index = Orbit seed',
                    'Wall budget': ('Bounded smoke: ' + config['wallSeconds'] + 's') if 'wallSeconds' in config else 'Native experiment budget',
                    'Source': COMMIT, 'Scoring': 'Native sealed-evidence evaluator and six-level process scorer'}},
            'metrics': [{'name': 'score', 'label': 'Success', 'unit': '%', 'primary': True},
                        {'name': 'processScore', 'label': 'Process score', 'unit': 'pts', 'range': [0, 100]},
                        {'name': 'reward', 'label': 'Native reward', 'range': [0, 1]}],
            **({'official': {'name': 'EmbodiedLab success', 'version': '0.1.0', 'unit': 'task', 'errors': 'exclude'}}
               if 'wallSeconds' not in config else {})}


def solve(req):
    root, config = settings(req)
    revision(root)
    trial = req['trial']
    if trial['task'] not in TASKS:
        raise ValueError('Unknown native experiment')
    if trial.get('options'):
        raise ValueError('No per-trial options; configure exposure/wallSeconds at registration')
    if trial.get('hostNetwork'):
        raise ValueError('The private simulator service requires a non-host-network auth profile')
    if trial['method']['agent'] in ('oracle', 'policy', 'external'):
        raise ValueError('Use a registered Agent CLI or empty; no reference oracle is released')
    if type(trial['seed']) is not int or trial['seed'] < 0:
        raise ValueError('Native dev instance index must be a nonnegative integer')
    resources = {'cpus': 2, 'memGB': 4, 'gpus': 0,
                 **{key: value for key, value in trial.get('resources', {}).items() if key != 'timeoutMin'}}
    if resources['gpus'] != 0:
        raise ValueError('The main Agent role must use zero GPUs; the simulator service owns its GPU lease')
    row = TASKS[trial['task']]
    wall = float(config.get('wallSeconds', row['budget']['wall_s']))
    if not math.isfinite(wall) or wall <= 0 or wall > row['budget']['wall_s']:
        raise ValueError('wallSeconds must be positive and no greater than the official task wall budget')
    if trial.get('timeoutMin') is not None:
        timeout = float(trial['timeoutMin']) * 60
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError('timeoutMin must be positive and finite')
        if timeout < row['budget']['wall_s'] and 'wallSeconds' not in config:
            raise ValueError('A shorter timeout requires explicit wallSeconds registration; '
                             'full-budget registrations retain the official aggregate')
        wall = min(wall, timeout)
    staging = Path(trial['staging'])
    staging.mkdir(parents=True, exist_ok=True)
    for name in ('service.py', 'verify.py'):
        shutil.copyfile(HERE / name, staging / name)
    helpers = HERE.parents[1] / 'tools/orbit-gui-service/evidence.py'
    shutil.copyfile(helpers, staging / 'evidence_helpers.py')
    key = staging / 'evidence-private.pem'
    fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.close(fd)
    subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(key)], check=True, capture_output=True)
    public = base64.b64encode(subprocess.check_output(['openssl', 'pkey', '-in', str(key), '-pubout', '-outform', 'DER'])).decode()
    plan = {'schema': 1, 'task': trial['task'], 'seed': trial['seed'], 'method': trial['method'],
            'commit': COMMIT, 'exposure': 'T0', 'wall_s': wall, 'official_wall_s': row['budget']['wall_s'],
            'sim_s': row['budget']['sim_s']}
    (staging / 'plan.json').write_text(json.dumps(plan))
    image = config.get('image', 'orbit-embodiedlab-agent:5dd50ff')
    spec = {'image': image, 'workdir': '/task', 'resources': resources,
            'timeoutMin': wall / 60, 'network': True, 'networks': [{'name': 'lab', 'internal': True}],
            'runNetworks': ['default', 'lab'], 'volumes': ['workspace'],
            'volumeMounts': [{'volume': 'workspace', 'target': '/task'}], 'dependsOn': ['lab'],
            'env': {'PYTHONDONTWRITEBYTECODE': '1'}, 'collect': ['/task'],
            'services': [{'name': 'lab', 'image': config.get('labImage', 'orbit-embodiedlab-lab:5dd50ff'),
                'entrypoint': '/isaac-sim/python.sh', 'command': ['/adapter/service.py', 'serve'],
                'binds': [{'source': str(staging), 'target': '/adapter', 'mode': 'ro'},
                          {'source': str(root), 'target': '/upstream', 'mode': 'ro'}],
                'volumes': [{'volume': 'workspace', 'target': '/agent-workspace'}],
                'env': {'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONPATH': '/upstream:/upstream/sdk/src:/opt/embodiedlab-python:/opt/embodiedlab/bench',
                        'ACCEPT_EULA': 'Y', 'PRIVACY_CONSENT': 'Y', PUBLIC_KEY: public},
                'role': 'sim', 'cpus': 8, 'memGB': 32, 'gpus': 1, 'gpuMemGB': 24,
                'gpuModels': ['RTX'], 'shmGB': 8, 'init': True, 'networks': ['lab'], 'collect': ['/evidence'],
                'healthcheck': {'command': ['/isaac-sim/python.sh', '/adapter/service.py', 'ready'],
                                'intervalSec': 5, 'timeoutSec': 5, 'startPeriodSec': 900, 'retries': 3}}],
            'hooks': [{'service': 'lab', 'command': '/isaac-sim/python.sh /adapter/service.py finalize', 'timeoutSec': 1200}]}
    if trial['method']['agent'] == 'empty':
        spec['command'] = ['true']
    else:
        spec['agentTask'] = {'instruction': 'Read /task/PROMPT.md and carry out the original EmbodiedLab experiment. '
            'The workspace contains the native task card, Python API, tools and submission schema. '
            'Use ./py for interactions. Inspect observations, write your own experiment code and submit once. '
            'Stay inside /task; simulator internals and evaluation data are private.'}
    return {'spec': spec, 'issues': ([f'Bounded smoke: wall budget {wall:g}s replaces native {row["budget"]["wall_s"]}s']
                                   if wall < row['budget']['wall_s'] else [])}


def public_key(req):
    service = next(s for s in req['solve']['run']['spec']['services'] if s['name'] == 'lab')
    value = service['env'][PUBLIC_KEY]
    if len(base64.b64decode(value, validate=True)) != 44:
        raise ValueError('Invalid saved service public key')
    return value


def verify(req):
    root, config = settings(req)
    revision(root)
    staging = Path(req['trial']['staging'])
    staging.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(HERE / 'verify.py', staging / 'verify.py')
    shutil.copyfile(HERE.parents[1] / 'tools/orbit-gui-service/evidence.py', staging / 'evidence_helpers.py')
    return {'spec': {'image': config.get('image', 'orbit-embodiedlab-agent:5dd50ff'),
        'command': ['python', '/adapter/verify.py', '/solve'], 'resources': {'cpus': 2, 'memGB': 4, 'gpus': 0},
        'network': False, 'timeoutMin': 10,
        'env': {'PYTHONPATH': '/upstream:/upstream/sdk/src', 'PYTHONDONTWRITEBYTECODE': '1', PUBLIC_KEY: public_key(req)},
        'mounts': [{'source': str(root), 'target': '/upstream', 'mode': 'ro'},
                   {'source': str(staging), 'target': '/adapter', 'mode': 'ro'},
                   {'source': str(Path(req['solve']['output']) / 'services/lab/evidence'), 'target': '/solve', 'mode': 'ro'}]}}


def score(req):
    review = {'files': [{'label': 'Native evaluation', 'phase': 'verify', 'kind': 'json', 'path': 'result.json'},
                        {'label': 'Process score', 'phase': 'verify', 'kind': 'json', 'path': 'process_score.json'},
                        {'label': 'Agent notes', 'phase': 'solve', 'kind': 'markdown', 'path': 'collected/task/NOTES.md'}]}
    try:
        result = json.loads((Path(req['verify']['output']) / 'result.json').read_text())
        if not result.get('valid'):
            raise ValueError(result.get('error', 'Native verifier failed'))
        if any(result['plan'][key] != req['trial'][key] for key in ('task', 'seed', 'method')):
            raise ValueError('Verified evidence belongs to another trial')
        review['details'] = {'Interface': 'T0', 'Wall budget': str(result['plan']['wall_s']) + 's',
                             'Condition': 'Bounded smoke; not a full-budget benchmark result'
                             if result['plan']['wall_s'] < result['plan']['official_wall_s'] else 'Native task budget'}
        return {'score': float(result['task_completed']), 'maxScore': 1, 'invalid': False, 'issues': [],
                'metrics': {'processScore': result['process_score'] * 100, 'reward': result['reward']}, 'review': review}
    except (OSError, KeyError, ValueError, TypeError) as exc:
        return {'score': None, 'maxScore': 1, 'invalid': True, 'failure': 'scorer_error', 'issues': [str(exc)], 'review': review}


if __name__ == '__main__':
    sys.exit(protocol_main(tasks, solve, verify, score))
