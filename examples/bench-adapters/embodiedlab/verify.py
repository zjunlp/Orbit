"""CPU-only native regrade of service-signed, agent-inaccessible evidence."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def validate_seal(root):
    from evidence_helpers import verify_signature
    verify_signature(root, os.environ['ORBIT_EMBODIEDLAB_EVIDENCE_PUBLIC_KEY'])
    seal = json.loads((root / 'result.json').read_text())
    if seal.get('schema') != 1:
        raise ValueError('Unknown evidence schema')
    files = {p.relative_to(root).as_posix(): p for p in root.rglob('*')
             if p.is_file() and p.relative_to(root).as_posix() not in ('result.json', 'evidence-signature.json')}
    if set(files) != set(seal['sha256']) or any(digest(p) != seal['sha256'][name] for name, p in files.items()):
        raise ValueError('Signed evidence is incomplete or has changed')
    if any(p.is_symlink() for p in root.rglob('*')):
        raise ValueError('Evidence must contain regular files, not symbolic links')
    return seal


def verify(root, output):
    from benchmark.instances import snapshot
    from benchmark.evaluation.evaluate import evaluate
    from benchmark.evaluation.process import score_trial
    from scripts.trial import infrastructure_end, STATUS_BY_END_REASON
    seal = validate_seal(root)
    trial = output / 'native-trial'
    shutil.copytree(root, trial, dirs_exist_ok=True)
    plan = seal['plan']
    if plan != json.loads((trial / 'plan.json').read_text()):
        raise ValueError('Evidence plan mismatch')
    instance = snapshot.for_evaluation(trial, trial / 'unused-store', '')
    if instance['exp_id'] != plan['task'] or instance['index'] != plan['seed']:
        raise ValueError('Native instance does not match the trial')
    capture = trial / 'captures/orbit-lab'
    process = capture / 'process'
    if not (process / 'episode.json').is_file():
        raise ValueError('No native process record: environment did not finalize')
    end = json.loads((process / 'episode.json').read_text())
    if end.get('instance_id') != instance['instance_id'] or end.get('exp_id') != plan['task']:
        raise ValueError('Native process record belongs to another instance')
    logs = json.loads((process / 'bench_logs.json').read_text()) if (process / 'bench_logs.json').is_file() else {}
    sealed = (capture / 'sealed/manifest.json').is_file()
    if not sealed and infrastructure_end(end, logs):
        raise ValueError('Native simulator infrastructure failure; trial must be rerun')
    if (end.get('end_reason') == 'stopped' and 'end_tick' in end and 'horizon_ticks' in end
            and end['horizon_ticks'] - end['end_tick'] < end.get('physics_hz', 240)):
        end['end_reason'] = 'sim_budget_exhausted'
    report = None
    if sealed:
        report = evaluate(capture / 'sealed', instance)
        (trial / 'evaluation.json').write_text(json.dumps(report, indent=2))
        shutil.copyfile(trial / 'evaluation.json', output / 'evaluation.json')
    elif end.get('submitted') or end.get('end_reason') == 'submitted':
        raise ValueError('Submitted trial lost its sealed evidence')
    process_score = score_trial(trial)
    (output / 'process_score.json').write_text(json.dumps(process_score, indent=2))
    status = ('submitted' if report else STATUS_BY_END_REASON.get(end.get('end_reason'),
              'timeout' if seal['close_reason'] == 'wall_limit' else 'not_submitted'))
    return {'valid': True, 'plan': plan, 'status': status,
            'task_completed': bool(report and report['task_completed']),
            'reward': report['reward'] if report else 0,
            'process_score': process_score['process_score'], 'process_level': process_score['level']}


def main():
    output = Path(os.environ['ORBIT_OUTPUT'])
    output.mkdir(parents=True, exist_ok=True)
    try:
        result = verify(Path(sys.argv[1]), output)
    except Exception as exc:
        result = {'valid': False, 'error': f'{type(exc).__name__}: {exc}'}
    (output / 'result.json').write_text(json.dumps(result, indent=2, allow_nan=False))
    return 0 if result['valid'] else 1


if __name__ == '__main__':
    sys.exit(main())
