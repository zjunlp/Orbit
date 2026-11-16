"""Independent original HLE judge; calibration controls never impersonate model runs."""
import asyncio
import contextlib
import io
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace


def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, allow_nan=False))


def json_object_transport(client):
    async def parse(*, response_format, messages, **kwargs):
        schema = json.dumps(response_format.model_json_schema())
        result = await client.chat.completions.create(**kwargs, response_format={'type': 'json_object'},
            messages=[{'role': 'system', 'content': 'Return only JSON conforming to this schema: ' + schema}, *messages])
        parsed = response_format.model_validate_json(result.choices[0].message.content)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(parsed=parsed))])
    return parse


async def verify(plan, output):
    file = Path('/solve/answer.json')
    raw = file.read_bytes() if file.exists() else None
    response = ''
    evidence = {'task': plan['task'], 'catalogSha256': plan['catalogSha256'],
                'responseSha256': hashlib.sha256(raw).hexdigest() if raw else None,
                'judgeModel': plan['judgeModel'], 'judgeFormat': plan.get('judgeFormat', 'json_schema'), 'invalid': False}
    if raw:
        try:
            value = json.loads(raw)
            if not isinstance(value, dict) or not isinstance(value.get('answer'), str) or type(value.get('confidence')) is not int or not 0 <= value['confidence'] <= 100:
                raise ValueError('Invalid answer format')
            response = value['answer'] + f"\nConfidence: {value['confidence']}%"
        except (ValueError, TypeError):
            write(output / 'verdict.json', {**evidence, 'judge': {'correct': 'no'},
                  'response_error': 'Expected JSON with an answer string and integer confidence 0..100'})
            return
    key = Path('/credentials/judge-key').read_text().strip()
    os.environ['OPENAI_API_KEY'] = key
    os.environ['OPENAI_BASE_URL'] = plan['judgeBaseUrl']
    spec = importlib.util.spec_from_file_location('hle_native_judge', '/upstream/run_judge_results.py')
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    native.args = SimpleNamespace(judge=plan['judgeModel'])
    if plan.get('judgeFormat') == 'json_object':
        native.client.beta.chat.completions.parse = json_object_transport(native.client)
    # Redact the key from upstream provider diagnostics before writing run logs.
    diagnostic = io.StringIO()
    with contextlib.redirect_stdout(diagnostic):
        result = await native.extract_answer(plan['question'], plan['answer'], response)
    if result is None:
        print(diagnostic.getvalue().replace(key, '[REDACTED]')[:2000])
        raise ValueError('Original HLE judge returned no verdict')
    if result['correct'] not in ('yes', 'no') or type(result['confidence']) is not int or not 0 <= result['confidence'] <= 100:
        raise ValueError('Original HLE judge returned malformed fields')
    write(output / 'verdict.json', {**evidence, 'judge': result})


def main():
    output = Path(os.environ['ORBIT_OUTPUT'])
    plan = json.loads(Path('/plan.json').read_text())
    mode = sys.argv[1]
    if mode in ('empty', 'oracle'):
        write(output / 'answer.json', {'answer': plan['answer'] if mode == 'oracle' else '',
                                       'confidence': 100 if mode == 'oracle' else 0})
    elif mode == 'verify':
        try:
            asyncio.run(verify(plan, output))
        except Exception as exc:
            write(output / 'verdict.json', {'invalid': True, 'error': type(exc).__name__})
            print('Native HLE judge failed:', type(exc).__name__)
    else:
        raise ValueError('Unknown runtime mode')


if __name__ == '__main__':
    main()
