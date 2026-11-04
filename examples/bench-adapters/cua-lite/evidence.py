"""Validate CUA-Lite's captured native reward without replaying the browser."""
import hashlib
import json
import math
import os
from pathlib import Path
import sys

COMMIT = '2af69268c0573f4c12aac391cc03125e6d5c7974'
MINIWOB_COMMIT = '7fd85d71a4b60325c6585396ec4f48377d049838'


def read(path):
    return json.loads(path.read_text())


def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate(output):
    plan, result, manifest = [read(output / n) for n in ('plan.json', 'result.json', 'manifest.json')]
    if plan['commit'] != COMMIT or plan['miniwob_commit'] != MINIWOB_COMMIT:
        raise ValueError('Unexpected source version')
    if not {'plan.json', 'result.json', 'events.jsonl'} <= manifest.keys():
        raise ValueError('Incomplete evidence manifest')
    for name, expected in manifest.items():
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or not path.parts:
            raise ValueError('Unsafe evidence path')
        target = output / path
        if target.is_symlink() or not target.resolve().is_relative_to(output.resolve()):
            raise ValueError('Unsafe evidence link')
        if digest(target) != expected:
            raise ValueError(f'Changed evidence: {name}')
    if result.get('failure'):
        if result['failure'] not in {'env_start', 'reset_failed', 'env_step', 'policy_start',
                                      'policy_act', 'server_unreachable', 'model_unavailable', 'scorer_error'}:
            raise ValueError('Unknown native failure classification')
        return {'score': None, 'maxScore': 1, 'invalid': True, 'failure': result['failure'],
                'issues': [f"CUA-Lite {result['failure']}: {result.get('error_type', 'native failure')}"]}
    events = [json.loads(line) for line in (output / 'events.jsonl').read_text().splitlines()]
    if not events or events[0]['kind'] != 'reset' or len(events) < 2:
        raise ValueError('No complete native episode')
    final = events[-1]
    if final['kind'] != 'step' or not (final['terminated'] or final['truncated']):
        raise ValueError('Native environment has no final verdict')
    if final['info'].get('pool_unreachable'):
        return {'score': None, 'maxScore': 1, 'invalid': True, 'failure': 'server_unreachable',
                'issues': ['Native environment reported an unreachable backend']}
    reward = final['reward']
    if isinstance(reward, bool) or not isinstance(reward, (int, float)) or not math.isfinite(reward) or reward not in (0, 1):
        raise ValueError('Missing native MiniWoB binary reward')
    if result['reward'] != reward or result['steps'] != len(events) - 1:
        raise ValueError('Result differs from native step evidence')
    return {'score': reward, 'maxScore': 1, 'invalid': False, 'issues': [], 'episode': {
        'steps': result['steps'], 'terminated': final['terminated'], 'truncated': final['truncated'],
        'endedBy': 'native_environment', 'successSignal': 'original BrowserGym reward'}}


if __name__ == '__main__':
    try:
        report = validate(Path(sys.argv[1]))
    except (OSError, ValueError, KeyError, TypeError):
        report = {'score': None, 'maxScore': 1, 'invalid': True, 'failure': 'scorer_error',
                  'issues': ['Captured evidence is incomplete or inconsistent']}
    write(Path(os.environ['ORBIT_OUTPUT']) / 'validation.json', report)
