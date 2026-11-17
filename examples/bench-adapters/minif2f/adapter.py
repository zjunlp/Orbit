#!/usr/bin/env -S python3 -B
"""miniF2F Lean 3 with fixed original statements and the native independent kernel checker."""
import hashlib
import json
from pathlib import Path
import re
import shlex
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import invalid, main, valid
from orbit_bench.batch import mount
from orbit_bench.questions import checked_source

HERE = Path(__file__).resolve().parent
RELEASE = json.loads((HERE / "release.json").read_text())


def rows(req):
    checked_source(req, HERE)
    root = Path(req["benchmark"]["path"])
    result = []
    for split in ("valid", "test"):
        source = (root / f"lean/src/{split}.lean").read_text()
        declarations = list(re.finditer(r"^theorem (\w+)", source, re.M))
        prelude = source[:declarations[0].start()]
        for i, match in enumerate(declarations):
            block = source[match.start():declarations[i+1].start() if i+1 < len(declarations) else len(source)]
            statement, proof = block.split(":=\n", 1)
            result.append({"task": split+"/"+match[1], "name": match[1], "prelude": prelude,
                           "statement": statement+":=\n", "proof": proof.strip()})
    return result


def tasks(req):
    return {"tasks": [{"id": r["task"], "title": r["task"], "supported": True, "reason": None, "tags": {"split": r["task"].split('/')[0]}} for r in rows(req)],
        "capabilities": {"identity": {"id": "minif2f", "name": "miniF2F", "version": RELEASE["revision"], "variant": "Lean-3.42.1"},
            "methods": ["cli", "external", "oracle", "empty"], "scoreKind": "scalar", "rescore": "evidence",
            "conditions": {"Scoring": "Native Lean elaboration, dependency export and independent leanchecker kernel",
                "Libraries": "Lean 3.42.1; original mathlib cb2b02fff213ed6f65bebd64446baac64137dcda",
                "Submission": "Proof expression only; immutable original statement; no added axioms or sorry"},
            "taxonomy": {"domains": ["mathematics"], "taskTypes": ["implementation"], "modalities": ["text"],
                         "interfaces": ["file-edit"], "scoringMethods": ["execution-test"]}}}


def installation(req):
    cfg = req["benchmark"].get("config") or {}
    raw = Path(cfg["toolManifest"]).read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != cfg.get("toolSha256"):
        raise ValueError("Set toolSha256 to the SHA-256 of toolManifest")
    root = Path(cfg["toolRoot"])
    files = json.loads(raw)
    required = ["lean/bin/lean", "lean/bin/leanchecker", "mathlib/leanpkg.toml"]
    if any(name not in files for name in required):
        raise ValueError("Manifest must cover the installed Lean binaries and mathlib")
    for name, expected in files.items():
        if Path(name).is_absolute() or '..' in Path(name).parts:
            raise ValueError("Invalid installed-tool manifest path")
        if hashlib.sha256((root/name).read_bytes()).hexdigest() != expected:
            raise ValueError(f"Installed toolchain changed: {name}")
    if '3.42.1' not in (root/'mathlib/leanpkg.toml').read_text():
        raise ValueError("Expected original Lean 3 mathlib installation")
    return root, digest, cfg


def stage(req, phase):
    row = next((r for r in rows(req) if r['task'] == req['trial']['task']), None)
    if row is None:
        raise ValueError("Unknown miniF2F theorem")
    root, digest, cfg = installation(req)
    visible = {k: row[k] for k in ('task', 'name', 'prelude', 'statement')}
    visible['source'] = {'revision': RELEASE['revision'], 'toolSha256': digest}
    path = Path(req['trial']['staging'])/phase; path.mkdir(parents=True, exist_ok=True)
    if phase == 'verify':
        saved = json.loads((Path(req['solve']['output'])/'collected/input/task.json').read_text())
        saved.pop('proof', None)
        if saved != visible:
            raise ValueError("Theorem or toolchain changed since solve")
    elif req['trial']['method']['agent'] == 'oracle':
        if re.search(r'\b(sorry|admit)\b', row['proof']):
            raise ValueError("No complete original reference proof is published for this theorem")
        visible['proof'] = row['proof']
    (path/'task.json').write_text(json.dumps(visible))
    imports = Path(req['benchmark']['path'])/'lean/src/minif2f_import.lean'
    return {'image': cfg.get('image', 'python:3.11-slim@sha256:e88e9763f943ec1834f992a4b51e0f24500486803e8bc534e5767af9ea65f6ce'),
        'mounts': [mount(path, '/input'), mount((root/'lean').resolve(), '/tools/lean'), mount((root/'mathlib').resolve(), '/tools/mathlib'), mount(HERE/'runtime.py', '/adapter/runtime.py'),
                   mount(imports, '/imports/minif2f_import.lean')],
        'env': {'PYTHONDONTWRITEBYTECODE': '1', 'LEAN_PATH': '/imports:/tools/mathlib/src:/tools/lean/lib/lean/library'},
        'resources': {'cpus': 2, 'memGB': 4, 'gpus': 0}, 'network': False, 'workdir': '/tmp',
        'timeoutMin': req['trial'].get('timeoutMin') or 30}


def solve(req):
    run = stage(req, 'solve'); method = req['trial']['method']
    run['collect'] = ['/input/task.json']
    if method['agent'] in ('oracle', 'empty'):
        run['command'] = ['python', '/adapter/runtime.py', method['agent']]
    elif method['agent'] == 'external':
        run['command'] = shlex.split(method['entrypoint'])
        if not run['command'] or not run['command'][0]:
            raise ValueError('External entrypoint must contain an executable')
        run['env'].update({'ORBIT_TASK_FILE': '/input/task.json', 'ORBIT_METHOD_CONFIG': json.dumps(method.get('config') or {})})
        run['network'] = True
    else:
        run['network'] = True
        run['agentTask'] = {'instruction': 'Prove the original Lean 3 theorem in /input/task.json. Write only its proof expression '
            '(for example begin ... end) to $ORBIT_OUTPUT/proof.lean. The verifier supplies the immutable statement and prelude. '
            'Use /tools/lean/bin/lean with the provided LEAN_PATH to try proofs locally. Lean 3.42.1 and the original mathlib are installed. '
            'No sorry, admit, extra axioms or statement changes are accepted. Empty or incorrect proofs score zero.'}
    return {'spec': run}


def verify(req):
    run = stage(req, 'verify')
    run['mounts'].append(mount(req['solve']['output'], '/solve'))
    run['command'] = ['python', '/adapter/runtime.py', 'verify']
    return {'spec': run}


def score(req):
    try:
        result = json.loads((Path(req['verify']['output'])/'result.json').read_text())
        if result['task'] != req['trial']['task']:
            raise ValueError('Result task mismatch')
        if result.get('error'):
            return invalid('scorer_error', result['error'])
        if type(result['proved']) is not bool:
            raise ValueError('Kernel result must be boolean')
        return valid(int(result['proved']), review={'files': [
            {'label': 'Proof', 'phase': 'solve', 'path': 'proof.lean', 'kind': 'text'},
            {'label': 'Lean output', 'phase': 'verify', 'path': 'lean.txt', 'kind': 'text'},
            {'label': 'Kernel result', 'phase': 'verify', 'path': 'result.json', 'kind': 'json'}]})
    except (OSError, ValueError, TypeError, KeyError) as exc:
        return invalid('scorer_error', str(exc))


if __name__ == '__main__':
    sys.exit(main(tasks, solve, verify, score))
