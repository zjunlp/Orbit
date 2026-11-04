"""Render only native reset/post-action frames with known observation timing."""
import json

from evidence import write


def capture(rows, output, goal):
    steps = []
    directory = output / 'review-frames'
    for row in rows:
        name, images = row.get('event_name'), row.get('data_images') or []
        if name not in ('reset', 'step:after', 'solve'):
            continue
        if not images or (not steps and name != 'reset'):
            break
        data = json.loads(row.get('data_json') or '{}')
        action = data.get('action') if name == 'step:after' else 'original solve_task hook'
        if name == 'step:after' and action is None:
            break
        directory.mkdir(exist_ok=True)
        target = directory / f'{len(steps):04d}.png'
        image = images[-1]
        if isinstance(image, bytes):
            target.write_bytes(image)
        else:
            image.save(target, format='PNG')
        steps.append({'step': len(steps), 'screenshot': target.relative_to(output).as_posix(),
                      'action': None if not steps else json.dumps(action, ensure_ascii=False),
                      'reward': None})
    if steps:
        write(output / 'trajectory-review.json', {'version': 1, 'goal': goal, 'steps': steps,
            'stopReason': 'Only native reset/post-action frames; full policy trace and verdict are in Native ATIF/result'})
