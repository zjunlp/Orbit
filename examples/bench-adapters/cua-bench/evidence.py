"""Validate immutable captures of the original live Cua evaluator (stdlib only)."""
import hashlib
import json
import math
import os
from pathlib import Path
import sys

COMMIT = '2829e00b180dfb08ca5ff4cbd7c95e0a14ad3409'
DESKTOP_IMAGE = 'ghcr.io/trycua/bench-web@sha256:3b7e1d9d4e34694175cf1b44ffefc09b557c94b1c8f946fe50646d68df39ca87'


def read(path):
    return json.loads(path.read_text())


def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate(output):
    plan, result, manifest = [read(output / n) for n in ('plan.json', 'result.json', 'manifest.json')]
    if plan['commit'] != COMMIT or plan['desktop_image'] != DESKTOP_IMAGE:
        raise ValueError('Unexpected source or image version')
    if not {'plan.json', 'result.json'} <= manifest.keys():
        raise ValueError('Incomplete evidence manifest')
    for name, value in manifest.items():
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or not path.parts:
            raise ValueError('Unsafe evidence path')
        target = output / path
        if target.is_symlink() or not target.resolve().is_relative_to(output.resolve()):
            raise ValueError('Unsafe evidence link')
        if digest(target) != value:
            raise ValueError(f'Changed evidence: {name}')
    if result.get('failure'):
        if result['failure'] not in {'env_start', 'reset_failed', 'env_step', 'policy_start',
                                      'policy_act', 'server_unreachable', 'model_unavailable', 'scorer_error'}:
            raise ValueError('Unknown native failure classification')
        return {'score': None, 'maxScore': 1, 'invalid': True, 'failure': result['failure'],
                'issues': [f"Cua {result['failure']}: {result.get('error_type', 'native failure')}"]}
    native = result['native']
    reward = native['reward']
    if isinstance(reward, bool) or not isinstance(reward, (int, float)) or not math.isfinite(reward) or not 0 <= reward <= 1:
        raise ValueError('Missing or invalid native reward')
    if native.get('evaluation') is None:
        raise ValueError('Original evaluator did not run')
    failure = native.get('failure_mode')
    if failure and failure not in ('FailureMode.NONE', 'FailureMode.UNSET', 'FailureMode.MAX_STEPS_EXCEEDED'):
        return {'score': None, 'maxScore': 1, 'invalid': True,
                'failure': 'model_unavailable' if failure == 'FailureMode.API_ERROR' else 'policy_act',
                'issues': ['Native agent reported ' + failure]}
    return {'score': reward, 'maxScore': 1, 'invalid': False, 'issues': [],
            'episode': {'endedBy': 'native_evaluator', 'successSignal': 'original evaluate_task reward'}}


if __name__ == '__main__':
    try:
        report = validate(Path(sys.argv[1]))
    except (OSError, ValueError, KeyError, TypeError):
        report = {'score': None, 'maxScore': 1, 'invalid': True, 'failure': 'scorer_error',
                  'issues': ['Captured evidence is incomplete or inconsistent']}
    write(Path(os.environ['ORBIT_OUTPUT']) / 'validation.json', report)
