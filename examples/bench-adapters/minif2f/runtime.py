"""Elaborate fixed miniF2F statements, audit exported axioms and run Lean's native kernel checker."""
import json
import os
from pathlib import Path
import subprocess
import sys

ALLOWED_AXIOMS = {'propext', 'quot.sound', 'classical.choice'}


def export_axioms(path, target):
    names = {0: ''}; axioms = set(); found = False
    for line in path.read_text().splitlines():
        fields = line.split()
        if len(fields) >= 4 and fields[1] in ('#NS', '#NI'):
            key = int(fields[0])
            if key in names:
                raise ValueError('Duplicate exported name id')
            names[key] = '.'.join(s for s in [names[int(fields[2])], fields[3]] if s)
        elif fields and fields[0] == '#AX':
            axioms.add(names[int(fields[1])])
        elif fields and fields[0] == '#DEF' and names[int(fields[1])] == target:
            found = True
    if not found:
        raise ValueError('Submitted theorem is missing from the native export')
    return axioms


def check(item, proof, out, lean='/tools/lean/bin/lean', checker='/tools/lean/bin/leanchecker'):
    result = {'task': item['task'], 'proved': False}
    if not proof.strip():
        result['reason'] = 'empty_proof'; return result
    preflight = out/'preflight.lean'; preflight.write_text(item['prelude'])
    with (out/'preflight.txt').open('w') as log:
        try:
            startup = subprocess.run([lean, '-j', '1', str(preflight)], stdout=log, stderr=subprocess.STDOUT, timeout=180)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError('Original imports/toolchain timed out; inspect preflight.txt') from exc
    if startup.returncode:
        raise RuntimeError('Original imports/toolchain failed; inspect preflight.txt')
    source = out/'submission.lean'
    source.write_text(item['prelude'] + '\n' + item['statement'] + proof + '\n')
    exported = out/'kernel.tlean'
    with (out/'lean.txt').open('w') as log:
        process = subprocess.run([lean, '-j', '1', '--export='+str(exported), '--only-export='+item['name'], str(source)],
                                 stdout=log, stderr=subprocess.STDOUT, timeout=600)
    if process.returncode:
        result['reason'] = 'elaboration_failed'; return result
    try:
        axioms = export_axioms(exported, item['name'])
    except (ValueError, KeyError) as exc:
        result['reason'] = str(exc); return result
    result['axioms'] = sorted(axioms)
    if axioms - ALLOWED_AXIOMS:
        result['reason'] = 'unapproved_axioms'; return result
    with (out/'kernel.txt').open('w') as log:
        kernel = subprocess.run([checker, str(exported)], stdout=log, stderr=subprocess.STDOUT, timeout=600)
    result['proved'] = kernel.returncode == 0
    result['reason'] = 'kernel_accepted' if result['proved'] else 'kernel_rejected'
    return result


def run(mode, src=Path('/input'), solve=Path('/solve'), out=None):
    out = out or Path(os.environ['ORBIT_OUTPUT']); out.mkdir(parents=True, exist_ok=True)
    item = json.loads((src/'task.json').read_text())
    if mode in ('oracle', 'empty'):
        (out/'proof.lean').write_text(item['proof'] if mode == 'oracle' else ''); return
    try:
        path = solve/'proof.lean'; proof = path.read_text() if path.is_file() else ''
        result = check(item, proof, out)
    except subprocess.TimeoutExpired:
        result = {'task': item['task'], 'proved': False, 'reason': 'proof_check_timeout'}
    except Exception as exc:
        result = {'task': item['task'], 'error': f'{type(exc).__name__}: {exc}'}
    (out/'result.json').write_text(json.dumps(result, indent=2)+'\n')


if __name__ == '__main__':
    run(sys.argv[1])
