"""Run a single original Cua episode against an Orbit-owned desktop."""
import asyncio
from dataclasses import asdict
from importlib.metadata import version
import os
from pathlib import Path
import random
import shutil
import sys
import time

from evidence import digest, read, write


def capture_review(result, env, output, goal):
    try:
        from trajectory import capture
        capture(env.tracing._rows, output, goal)
    except Exception as error:
        result['trajectory_error_type'] = type(error).__name__
        print(f'Optional native frame review unavailable: {type(error).__name__}', file=sys.stderr)


async def close_connections(result, session, sandbox):
    errors = {}
    for name, resource, method in [('session', session, 'close'), ('sandbox', sandbox, 'disconnect')]:
        if resource is not None:
            try:
                await getattr(resource, method)()
            except Exception as error:
                errors[name] = type(error).__name__
    if errors:
        result['connection_close_errors'] = errors


async def run(plan_path, output):
    output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(plan_path, output / 'plan.json')
    plan = read(plan_path)
    phase = 'env_start'
    result = {}
    session = sandbox = None
    started = time.monotonic()
    try:
        if version('cua') != '0.10.1':
            raise ValueError('Expected cua SDK 0.10.1')
        import numpy as np
        import cua_bench as cb
        from cua_sandbox import Sandbox
        from cua_bench.computers.remote import RemoteDesktopSession
        from cua_bench.runner.episode import AgentOptions, run_episode
        random.seed(plan['seed'])
        np.random.seed(plan['seed'] % (2**32))
        row = plan['native']
        task_path = Path('/tasks') / row['path']
        if digest(task_path / 'main.py') != row['source_sha256']:
            raise ValueError('Original task changed since planning')
        env = cb.make(str(task_path))
        native_task = env.tasks_config_fn()[row['variant']]
        if native_task.description != row['title'] or native_task.computer != row['computer']:
            raise ValueError('Catalog differs from original task factory')
        token = Path('/run/cua/env-token').read_text().strip()
        for attempt in range(60):
            try:
                sandbox = await Sandbox.connect(url='http://desktop:3211', token=token, telemetry_enabled=False)
                break
            except Exception:
                if attempt == 59:
                    raise
                await asyncio.sleep(2)
        cfg = native_task.computer['setup_config']
        session = RemoteDesktopSession.attach(sandbox, os_type='linux', width=cfg['width'], height=cfg['height'])
        for attr, label in [('setup_task_fn', 'reset_failed'), ('solve_task_fn', 'policy_act'),
                            ('evaluate_task_fn', 'scorer_error')]:
            original = getattr(env, attr)
            if original is not None:
                async def tracked(*args, _fn=original, _label=label, **kwargs):
                    nonlocal phase
                    phase = _label
                    value = await _fn(*args, **kwargs)
                    phase = 'policy_act'
                    return value
                setattr(env, attr, tracked)
        method = plan['method']
        opts = AgentOptions(oracle=method['agent'] == 'oracle', dump=method['agent'] == 'empty',
                            max_steps=plan['max_steps'], model=method.get('model'), save_pngs=True)
        if method['agent'] == 'external':
            for name in method.get('passEnv', []):
                if not os.environ.get(name):
                    phase = 'model_unavailable'
                    raise ValueError('Requested model variable is missing')
            entry = method['entrypoint']
            if ':' in entry:
                opts.agent_import_path = entry
            else:
                opts.agent = entry
        phase = 'policy_act'
        episode = await run_episode(env, row['variant'], opts, output / 'native', session=session)
        result['native'] = asdict(episode)
        capture_review(result, env, output, row['title'])
    except Exception as error:
        result.update(failure=phase, error_type=type(error).__name__)
        print(f'Cua {phase}: {type(error).__name__}', file=sys.stderr)
    finally:
        await close_connections(result, session, sandbox)
        result['elapsed_sec'] = time.monotonic() - started
        # Datetime values are native timing metadata, converted without changing the reward.
        import json
        write(output / 'result.json', json.loads(json.dumps(result, default=str, allow_nan=False)))
        secrets = [os.environ[n] for n in plan['method'].get('passEnv', []) if os.environ.get(n)]
        for path in output.rglob('*'):
            if path.is_file() and path.suffix in ('.json', '.jsonl', '.log', '.txt', '.md'):
                data = path.read_text()
                for secret in secrets:
                    data = data.replace(secret, '[redacted]')
                path.write_text(data)
        write(output / 'manifest.json', {p.relative_to(output).as_posix(): digest(p)
              for p in sorted(output.rglob('*')) if p.is_file() and p.name != 'manifest.json'})
    return 1 if result.get('failure') else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(run(Path(sys.argv[1]), Path(os.environ['ORBIT_OUTPUT']))))
