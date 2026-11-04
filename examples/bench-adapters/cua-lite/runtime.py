"""Capture native CUA-Lite env calls; the native agent owns its sampling loop."""
import asyncio
from dataclasses import asdict
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import shutil
import sys
from threading import Thread

from evidence import digest, read, write


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def native_config(config):
    result = {}
    for key, value in config.items():
        try:
            result[key] = json.loads(value)
        except json.JSONDecodeError:
            result[key] = value
    return result


async def run(plan_path, output):
    output.mkdir(parents=True, exist_ok=True)
    (output / 'screenshots').mkdir(exist_ok=True)
    shutil.copyfile(plan_path, output / 'plan.json')
    (output / 'events.jsonl').touch()
    plan, events, result = read(plan_path), [], {}
    env = server = None
    phase = 'env_start'

    def save(data):
        if isinstance(data, bytes):
            name = f'screenshots/{len(list((output / "screenshots").glob("*.png"))):04d}.png'
            (output / name).write_bytes(data)
            return {'image_path': name}
        if isinstance(data, dict):
            return {k: save(v) for k, v in data.items()}
        if isinstance(data, (list, tuple)):
            return [save(v) for v in data]
        return data

    def record(event):
        row = save(event)
        events.append(row)
        with (output / 'events.jsonl').open('a') as stream:
            stream.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + '\n')
            stream.flush()

    try:
        if any(version(p) != '0.14.3' for p in ('browsergym-miniwob', 'browsergym-core')):
            raise ValueError('Expected BrowserGym 0.14.3')
        server = ThreadingHTTPServer(('127.0.0.1', 7560), partial(QuietHandler, directory='/miniwob'))
        Thread(target=server.serve_forever, daemon=True).start()
        import lite.gym as gym
        from lite.gym.wrappers import EnvWrapper
        from lite.core.tools import make_tool_call

        class Capture(EnvWrapper):
            async def reset(self):
                nonlocal phase
                if events:
                    raise RuntimeError('One reset/episode per Orbit trial')
                phase = 'reset_failed'
                observation = await self.env.reset()
                record({'kind': 'reset', **asdict(observation)})
                phase = 'policy_act'
                return observation

            async def step(self, actions):
                nonlocal phase
                if not events or (events[-1].get('terminated') or events[-1].get('truncated')):
                    raise RuntimeError('Episode is not active')
                phase = 'env_step'
                reply = await self.env.step(actions)
                record({'kind': 'step', 'actions': actions, **asdict(reply)})
                phase = 'policy_act'
                return reply

        env = Capture(gym.make(plan['task'], seed=plan['seed'], max_steps=plan['max_steps']))
        method = plan['method']
        if method['agent'] == 'empty':
            await env.reset()
            await env.step([make_tool_call('terminate', {'status': 'success', 'reason': ''}, call_id='empty-finish')])
        else:
            phase = 'policy_start'
            for name in method.get('passEnv', []):
                if not os.environ.get(name):
                    phase = 'model_unavailable'
                    raise ValueError('Requested model variable is missing')
            entrypoint = method['entrypoint']
            if ':' in entrypoint:
                module, factory = entrypoint.split(':', 1)
                agent = getattr(importlib.import_module(module), factory)({
                    'method': method, 'seed': plan['seed'], 'metadata': env.metadata.to_dict()})
            else:
                from lite.agents import make
                if not method.get('model'):
                    raise ValueError('Native CUA-Lite agent needs method.model')
                agent = make(method['model'], env=env, agent_id=entrypoint,
                             **native_config(method.get('config') or {}))
            phase = 'policy_act'
            sample = await agent.sample(env)
            if sample is not None:
                from lite.agents.core.agent.logger import sanitize_trajectory_json
                write(output / 'sample.json', sanitize_trajectory_json(asdict(sample)))
        result.update(reward=events[-1].get('reward'), steps=len(events) - 1)
    except Exception as error:
        result.update(failure=phase, error_type=type(error).__name__)
        if isinstance(error, ModuleNotFoundError):
            result['missing_module'] = error.name
            print(f'Missing native module: {error.name}', file=sys.stderr)
        print(f'CUA-Lite {phase}: {type(error).__name__}', file=sys.stderr)
    finally:
        if env is not None:
            try:
                await env.close()
            except Exception as error:
                result.update(failure='server_unreachable', error_type=type(error).__name__)
        if server is not None:
            server.shutdown()
            server.server_close()
        write(output / 'result.json', result)
        view = []
        for index, event in enumerate(events):
            images = ([event['image']] if event.get('image') else
                      [image for r in event.get('results', []) for image in r.get('images', [])])
            if not images:
                break
            view.append({'step': index, 'screenshot': images[-1]['image_path'],
                'action': None if index == 0 else json.dumps(event['actions'], ensure_ascii=False),
                'reward': event.get('reward'), 'terminated': event.get('terminated', False),
                'truncated': event.get('truncated', False),
                'actionError': '\n'.join(r['error'] for r in event.get('results', []) if r.get('error'))})
        if view:
            write(output / 'trajectory-review.json', {'version': 1, 'goal': events[0].get('text') or '',
                  'steps': view, 'stopReason': 'Native frame capture ends here; full terminal verdict is in Native result'})
        secrets = [os.environ[n] for n in plan['method'].get('passEnv', []) if os.environ.get(n)]
        for path in output.rglob('*'):
            if path.is_file() and path.suffix in ('.json', '.jsonl'):
                text = path.read_text()
                for secret in secrets:
                    text = text.replace(secret, '[redacted]')
                path.write_text(text)
        write(output / 'manifest.json', {p.relative_to(output).as_posix(): digest(p)
              for p in sorted(output.rglob('*')) if p.is_file() and p.name != 'manifest.json'})
    return 1 if result.get('failure') else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(run(Path(sys.argv[1]), Path(os.environ['ORBIT_OUTPUT']))))
