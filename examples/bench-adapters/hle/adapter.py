#!/usr/bin/env -S python3 -B
"""Public HLE with restricted web tools and an offline native CLI environment."""
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / 'sdk'))
from orbit_bench import invalid, main, pinned, valid
from prepare import DATASET_REVISION, PARQUET_SHA256, sha, write

SOURCE_REVISION = '22ed3074b1e7b134bcbc09028d0ba320839b0655'
PINS = {
    'docs/blocklist.json': '3abaf35e03d6d5d361d2611746683a32315fe73ef851ec5f33c54b3c6a526575',
    'docs/requirements-tools.txt': 'c1c626beb8f2fab11609f6ed41a2721d9acd139554d6ce3c8c83f52a49797068',
    'hle_eval/run_judge_results.py': 'a796e74d6e58beab3bd88f46182f599443a102308b2d1c7e0b4b22f578468446',
}
KEYS = {'image', 'gatewayImage', 'source', 'catalogSha256', 'judgeKeyFile', 'judgeBaseUrl',
        'judgeModel', 'modelBaseUrl'}


def settings(req):
    cfg = req['benchmark']['config']
    if set(cfg) - (KEYS | {'judgeFormat'}) or not KEYS <= cfg.keys():
        raise ValueError('HLE requires: ' + ', '.join(sorted(KEYS)) + '; optional: judgeFormat')
    if cfg.get('judgeFormat', 'json_schema') not in ('json_schema', 'json_object'):
        raise ValueError('judgeFormat must be json_schema or json_object')
    if not pinned(cfg['image']) or not pinned(cfg['gatewayImage']):
        raise ValueError('Both runtime images must use immutable IDs/digests')
    source = Path(cfg['source'])
    for name, expected in PINS.items():
        if sha(source / name) != expected:
            raise ValueError('Changed upstream file: ' + name)
    root = Path(req['benchmark']['path'])
    if sha(root / 'catalog.json') != cfg['catalogSha256']:
        raise ValueError('Changed HLE catalog')
    catalog = json.loads((root / 'catalog.json').read_text())
    if catalog.get('revision') != DATASET_REVISION or catalog.get('parquetSha256') != PARQUET_SHA256:
        raise ValueError('Expected the pinned public HLE split')
    if sha(root / 'answers.json') != catalog['answersSha256']:
        raise ValueError('Changed answer index')
    return cfg, root, catalog


def tasks(req):
    cfg, root, catalog = settings(req)
    rows = []
    for row in catalog['tasks']:
        ready = all((root / 'questions' / row['id'] / name).is_file() for name in row['files'])
        rows.append({'id': row['id'], 'title': row['title'], 'supported': ready,
                     'reason': None if ready else 'Question assets missing',
                     'tags': {'oracle': 'full', 'category': row['category'], 'image': str(row['image']).lower()}})
    return {'tasks': rows, 'capabilities': {
        'identity': {'id': 'hle', 'name': 'Humanity\'s Last Exam', 'version': DATASET_REVISION,
                     'variant': 'public-with-tools'},
        'taxonomy': {'domains': ['science'], 'taskTypes': ['answering'],
                     'targets': ['reasoning', 'tool-use'], 'modalities': ['text', 'image'],
                     'interfaces': ['terminal', 'tool-api'], 'platforms': ['software-system'],
                     'world': ['live'], 'feedback': ['step'],
                     'scoringEvidence': ['response'], 'scoringMethods': ['model-judge']},
        'methods': ['empty', 'oracle', 'claude-code'], 'requires': ['mcp'],
        'scoreKind': 'binary', 'rescore': 'evidence',
        'conditions': {'Dataset': 'Original public cais/hle (2500); not HLE-Diamond',
            'Tools': 'Offline Python 3.11.16 plus pinned packages; filtered web_search/web_fetch',
            'Web': 'Bing RSS (20 candidates), text/PDF, 60000 characters, 20 MiB/document, 200 calls/trial',
            'Harness': 'Native Claude Code; its actual installed version is recorded by Orbit',
            'Judge': cfg['judgeModel'] + '; original HLE prompt/schema; ' + cfg.get('judgeFormat', 'json_schema'),
            'Parity': 'Model, judge, web backend and CLI version are explicit conditions; no official leaderboard parity claim',
            'Filter policy': SOURCE_REVISION, 'Network': 'Agent has network=none; Unix socket to restricted gateway',
            'Aggregation': 'Orbit valid-only sample accuracy; not upstream full-set metrics'}}}


def selected(req):
    cfg, root, catalog = settings(req)
    ident = req['trial']['task']
    row = next((r for r in catalog['tasks'] if r['id'] == ident), None)
    if row is None:
        raise ValueError('Unknown HLE question')
    folder = root / 'questions' / ident
    expected_names = {'question.json', 'image.png'} if row['image'] else {'question.json'}
    if (folder.is_symlink() or set(row['files']) != expected_names
            or {f.name for f in folder.iterdir()} != expected_names
            or any((folder / name).is_symlink() for name in expected_names)):
        raise ValueError('Unexpected question assets')
    for name, expected in row['files'].items():
        if Path(name).name != name or sha(folder / name) != expected:
            raise ValueError('Changed question assets')
    return cfg, root, row, folder


def plan(req, phase):
    cfg, root, row, folder = selected(req)
    trial = req['trial']
    method = trial['method']['agent']
    if method not in ('empty', 'oracle', 'claude-code'):
        raise ValueError('HLE currently supports native Claude Code, empty and oracle')
    staging = Path(trial['staging'])
    staging.mkdir(parents=True, exist_ok=True)
    question = json.loads((folder / 'question.json').read_text())
    payload = {'task': row['id'], 'catalogSha256': cfg['catalogSha256'],
               'question': question['question'], 'method': method,
               'judgeModel': cfg['judgeModel'], 'judgeBaseUrl': cfg['judgeBaseUrl'],
               'judgeFormat': cfg.get('judgeFormat', 'json_schema')}
    mounts = [{'source': str(HERE), 'target': '/hle-adapter', 'mode': 'ro'}]
    if phase == 'verify' or method == 'oracle':
        answer = json.loads((root / 'answers.json').read_text())[row['id']]
        if answer['question'] != question['question']:
            raise ValueError('Question/answer identity mismatch')
        payload['answer'] = answer['answer']
    file = staging / (phase + '-plan.json')
    write(file, payload)
    mounts.append({'source': str(file), 'target': '/plan.json', 'mode': 'ro'})
    if phase == 'verify':
        mounts += [{'source': req['solve']['output'], 'target': '/solve', 'mode': 'ro'},
                   {'source': str(Path(cfg['source']) / 'hle_eval/run_judge_results.py'),
                    'target': '/upstream/run_judge_results.py', 'mode': 'ro'},
                   {'source': cfg['judgeKeyFile'], 'target': '/credentials/judge-key', 'mode': 'ro'}]
        return {'spec': {'image': cfg['gatewayImage'], 'mounts': mounts, 'network': True,
                         'command': ['python', '-B', '/hle-adapter/runtime.py', 'verify'],
                         'resources': {'cpus': 1, 'memGB': 3, 'gpus': 0}, 'timeoutMin': 6}}
    spec = {'image': cfg['image'], 'network': False, 'mounts': mounts,
            'resources': {'cpus': 2, 'memGB': 4, 'gpus': 0},
            'timeoutMin': trial.get('timeoutMin') or 20,
            'env': {'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1'}}
    if method in ('empty', 'oracle'):
        spec['command'] = ['python', '-B', '/hle-adapter/runtime.py', method]
        return {'spec': spec}
    if not trial['method'].get('auth') or not trial['method'].get('model'):
        raise ValueError('Claude Code needs a dedicated relay auth profile and an explicit model')
    gateway_file = staging / 'gateway-config.json'
    write(gateway_file, {'question': question['question'], 'blocklist': '/blocklist.json',
                        'model': trial['method']['model'], 'modelBaseUrl': cfg['modelBaseUrl']})
    spec.update({'root': True, 'workdir': '/workspace',
                 'runNetworks': [], 'networks': [{'name': 'web', 'internal': False}],
                 'volumes': ['hle-ipc'],
                 'volumeMounts': [{'volume': 'hle-ipc', 'target': '/hle-ipc', 'mode': 'ro'}],
                 'dependsOn': ['hle-gateway'],
                 'services': [{'name': 'hle-gateway', 'image': cfg['gatewayImage'],
                    'command': ['python', '-B', '/hle-adapter/gateway.py'],
                    'networks': ['web'], 'cpus': 1, 'memGB': 2, 'init': True,
                    'volumes': [{'volume': 'hle-ipc', 'target': '/hle-ipc', 'mode': 'rw'}],
                    'binds': [{'source': str(HERE), 'target': '/hle-adapter', 'mode': 'ro'},
                              {'source': str(gateway_file), 'target': '/gateway-config.json', 'mode': 'ro'},
                              {'source': str(Path(cfg['source']) / 'docs/blocklist.json'), 'target': '/blocklist.json', 'mode': 'ro'}],
                    'collect': ['/evidence'],
                    'healthcheck': {'command': ['python', '-c', 'import socket; s=socket.socket(socket.AF_UNIX); s.connect("/hle-ipc/gateway.sock"); s.close()'],
                                    'intervalSec': 1, 'timeoutSec': 3, 'retries': 30}}],
                 'agentTask': {'instruction':
                    'Solve the question in /question/question.json. If present, inspect /question/image.png. '
                    'Use only local shell/Python for computation and hle_web web_search/web_fetch for external information. '
                    'The code environment has no internet. Do not install packages or use other web tools. '
                    'Write your final response as JSON with keys answer (string) and confidence (integer 0..100) '
                    'to /orbit/output/answer.json. Give a concise exact final answer; do not omit the output file.',
                    'tools': [{'name': 'hle-web', 'command': ['python3', '-B', '/hle-adapter/mcp.py']}]}})
    # The adapter entrypoint starts a loopback relay before Orbit's generated native CLI command.
    spec['entrypoint'] = '/hle-adapter/entrypoint.sh'
    spec['env'].update({'HLE_SOCKET': '/hle-ipc/gateway.sock',
                        'ANTHROPIC_DEFAULT_HAIKU_MODEL': trial['method']['model'],
                        'ANTHROPIC_DEFAULT_SONNET_MODEL': trial['method']['model'],
                        'ANTHROPIC_DEFAULT_OPUS_MODEL': trial['method']['model'],
                        'CLAUDE_CODE_SUBAGENT_MODEL': trial['method']['model'],
                        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'})
    spec['mounts'] += [{'source': str(folder), 'target': '/question', 'mode': 'ro'},
                       {'source': str(Path(cfg['source']) / 'docs/requirements-tools.txt'),
                        'target': '/hle-requirements.txt', 'mode': 'ro'}]
    return {'spec': spec}


def score(req):
    review = {'files': [{'label': 'Native HLE judge', 'phase': 'verify', 'path': 'verdict.json', 'kind': 'json'},
                        {'label': 'Final answer', 'phase': 'solve', 'path': 'answer.json', 'kind': 'json'}]}
    try:
        cfg, _, row, _ = selected(req)
        verdict = json.loads((Path(req['verify']['output']) / 'verdict.json').read_text())
        if verdict.get('invalid'):
            return invalid('judge_unavailable', verdict.get('error', 'Judge failed'), review=review)
        path = Path(req['solve']['output']) / 'answer.json'
        digest = sha(path) if path.exists() else None
        if (verdict['task'] != row['id'] or verdict['catalogSha256'] != cfg['catalogSha256']
                or verdict['responseSha256'] != digest or verdict['judgeModel'] != cfg['judgeModel']
                or verdict.get('judgeFormat', 'json_schema') != cfg.get('judgeFormat', 'json_schema')):
            raise ValueError('Verdict identity mismatch')
        judged = verdict['judge']
        if judged['correct'] not in ('yes', 'no'):
            raise ValueError('Malformed native judge verdict')
        return valid(int(judged['correct'] == 'yes'), review=review)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return invalid('scorer_error', str(exc), review=review)


if __name__ == '__main__':
    sys.exit(main(tasks, lambda req: plan(req, 'solve'), lambda req: plan(req, 'verify'), score))
