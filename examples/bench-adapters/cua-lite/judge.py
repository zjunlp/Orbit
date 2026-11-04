"""Run the original terminal evaluator after policy exit, using its captured native inputs."""
import asyncio
import importlib
import json
import os
from pathlib import Path
import sys

from evidence import COMMIT, check_judge_verdict, digest, read, validate, write
from web_suites import WEB_SUITES


def restore_native(state, output):
    suite = state['suite']
    detail = WEB_SUITES[suite]
    module = importlib.import_module('lite.gym.envs.' + detail['path'].replace('/', '.') + '.main')
    for key, expected in [('EVAL_MODEL', detail['model']), ('EVAL_API_KEY_VAR', 'OPENAI_API_KEY')]:
        value = os.environ.get(f"{detail['prefix']}_{key}")
        if value and value != expected:
            raise ValueError('The recorded native judge configuration cannot be overridden')
    cls = module.RemoteWebVoyagerEnv if suite == 'webharbor.webvoyager' else module.RemoteOnlineMind2WebEnv
    env = cls(task_id=state['task_id'], task=state['task'], base_max_steps=state['max_steps'],
              max_steps=state['max_steps'], skip_eval=False,
              eval_config={'image_judge_workers': 1} if suite == 'online_mind2web' else None)
    paths = [output / name for name in state['images']]
    if suite == 'webharbor.webvoyager':
        env._screenshots = [path.read_bytes() for path in paths]
        env._agent_response = state['agent_response']
    else:
        env._trajectory_steps = state['trajectory_steps']
        env._image_paths = [str(path) for path in paths]
        env._agent_final_answer = state.get('agent_final_answer')
    return env


def judge_failure(error):
    names = {type(error).__name__}
    cause = error.__cause__ or error.__context__
    while cause is not None:
        names.add(type(cause).__name__)
        cause = cause.__cause__ or cause.__context__
    if names & {'EnvDepsMissingError', 'AuthenticationError', 'PermissionDeniedError',
                'RateLimitError', 'APIConnectionError', 'APITimeoutError', 'InternalServerError',
                'NotFoundError', 'TimeoutError', 'ConnectionError', 'ModuleNotFoundError'}:
        return 'judge_unavailable'
    return 'scorer_error'


async def run(output):
    plan = read(output / 'plan.json')
    if not plan.get('deferred_judge'):
        raise ValueError('This after phase is only for the native Web terminal judge')
    if read(output / 'result.json').get('failure'):
        write(output / 'validation.json', validate(output))
        return 0
    suite, task = plan['task'].split('@', 1)
    result = {'commit': COMMIT, 'suite': suite, 'task_id': task,
              'input_sha256': digest(output / 'judge-input.json') if (output / 'judge-input.json').is_file() else None}
    try:
        validate(output, allow_pending_judge=True)
        state = read(output / 'judge-input.json')
        native = restore_native(state, output)
        if suite == 'webharbor.webvoyager':
            native._require_eval_deps()
        reward, info = await native._evaluate()
        result.update(reward=reward, info=info)
        check_judge_verdict(suite, reward, info, len(state['images']))
    except Exception as error:
        result.update(failure=judge_failure(error), error_type=type(error).__name__)
        print(f"CUA-Lite terminal judge: {result['failure']} ({result['error_type']})", file=sys.stderr)
    text = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)
    if secret := os.environ.get('OPENAI_API_KEY'):
        text = text.replace(secret, '[redacted]')
    (output / 'judge-result.json').write_text(text + '\n')
    manifest = read(output / 'manifest.json')
    manifest['judge-result.json'] = digest(output / 'judge-result.json')
    write(output / 'manifest.json', manifest)
    try:
        report = validate(output)
    except (OSError, ValueError, KeyError, TypeError):
        report = {'score': None, 'maxScore': 1, 'invalid': True, 'failure': 'scorer_error',
                  'issues': ['Captured web evidence is incomplete or inconsistent']}
    write(output / 'validation.json', report)
    return 1 if result.get('failure') else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(run(Path(os.environ['ORBIT_OUTPUT']))))
