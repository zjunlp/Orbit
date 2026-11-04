"""Validate CUA-Lite's captured native reward without replaying the browser."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys

COMMIT = '2af69268c0573f4c12aac391cc03125e6d5c7974'
MINIWOB_COMMIT = '7fd85d71a4b60325c6585396ec4f48377d049838'


def read(path):
    return json.loads(path.read_text())


def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_judge_verdict(suite, reward, info, image_count):
    if reward is None:
        return
    if not isinstance(info, dict):
        raise ValueError('Original judge returned malformed metadata')
    verdict = info.get('eval_verdict')
    if not isinstance(verdict, str):
        raise ValueError('Original judge returned a malformed verdict')
    if suite == 'webharbor.webvoyager':
        if 'SUCCESS' not in verdict:
            raise ValueError('Original WebVoyager judge returned a malformed verdict')
    else:
        status = verdict.lower().split('status:', 1)
        if len(status) != 2 or not re.search(r'\b(success|failure)\b', status[1]):
            raise ValueError('Original Online-Mind2Web judge returned a malformed verdict')
        records = info.get('image_judge_record')
        if not isinstance(records, list) or len(records) != image_count:
            raise ValueError('Original Online-Mind2Web image judgments are incomplete')
        # Upstream sets Score = 0 for unparseable judge text ("legitimately not important"); 1..5 otherwise.
        if any(not isinstance(row, dict) or type(row.get('Score')) is not int or not 0 <= row['Score'] <= 5
               for row in records):
            raise ValueError('Original Online-Mind2Web image judgment is malformed')


def validate(output, *, allow_pending_judge=False):
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
    if result['reward'] != reward or result['steps'] != len(events) - 1:
        raise ValueError('Result differs from native step evidence')
    signal = 'original BrowserGym reward'
    if plan.get('deferred_judge'):
        if reward is not None or 'judge-input.json' not in manifest:
            raise ValueError('Deferred web evaluation lacks native inputs')
        state = read(output / 'judge-input.json')
        suite, task = plan['task'].split('@', 1)
        expected_model = {'webharbor.webvoyager': 'gpt-4.1', 'online_mind2web': 'o4-mini'}[suite]
        if (state.get('schema') != 1 or state.get('suite') != suite or state.get('task_id') != task
                or state.get('model') != expected_model or state.get('max_steps') != plan['max_steps']):
            raise ValueError('Native judge input belongs to another episode or configuration')
        if not isinstance(state.get('images'), list) or not state['images']:
            raise ValueError('Native judge image buffer is missing')
        for index, name in enumerate(state['images']):
            if name != f'judge-input/{index:04d}.png' or name not in manifest:
                raise ValueError('Native judge image is missing or out of order')
        if allow_pending_judge:
            return {'score': None, 'maxScore': 1, 'invalid': True, 'failure': 'judge_unavailable',
                    'issues': ['Native terminal judge has not run yet']}
        if 'judge-result.json' not in manifest:
            raise ValueError('Native terminal judge did not produce evidence')
        judged = read(output / 'judge-result.json')
        if (judged.get('commit') != COMMIT or judged.get('suite') != suite or judged.get('task_id') != task
                or judged.get('input_sha256') != digest(output / 'judge-input.json')):
            raise ValueError('Native judge result belongs to another capture')
        if judged.get('failure'):
            if judged['failure'] not in {'judge_unavailable', 'scorer_error'}:
                raise ValueError('Unknown native judge failure')
            return {'score': None, 'maxScore': 1, 'invalid': True, 'failure': judged['failure'],
                    'issues': [f"Native judge: {judged.get('error_type', 'failed')}"]}
        reward = judged['reward']
        check_judge_verdict(suite, reward, judged['info'], len(state['images']))
        if (reward is None and suite == 'webharbor.webvoyager' and not state.get('agent_response')
                and judged['info'].get('eval_skip_reason') == 'no_agent_response'):
            reward = 0
        signal = 'original CUA-Lite terminal judge (after phase)'
    if isinstance(reward, bool) or not isinstance(reward, (int, float)) or not math.isfinite(reward) or reward not in (0, 1):
        raise ValueError('Missing native binary reward')
    return {'score': reward, 'maxScore': 1, 'invalid': False, 'issues': [], 'episode': {
        'steps': result['steps'], 'terminated': final['terminated'], 'truncated': final['truncated'],
        'endedBy': 'native_environment', 'successSignal': signal}}


if __name__ == '__main__':
    try:
        report = validate(Path(sys.argv[1]))
    except (OSError, ValueError, KeyError, TypeError):
        report = {'score': None, 'maxScore': 1, 'invalid': True, 'failure': 'scorer_error',
                  'issues': ['Captured evidence is incomplete or inconsistent']}
    write(Path(os.environ['ORBIT_OUTPUT']) / 'validation.json', report)
