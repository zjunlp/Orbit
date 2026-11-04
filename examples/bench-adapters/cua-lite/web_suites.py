"""Pinned browser-suite metadata and capture of the native terminal judge inputs."""
import shutil

from evidence import write


WEB_SUITES = {
    'webharbor.webvoyager': {
        'path': 'webharbor/webvoyager', 'image': 'webVoyagerImage',
        'prefix': 'WEBHARBOR_WEBVOYAGER', 'model': 'gpt-4.1', 'steps': 15,
        'tasks': {'allrecipes.0', 'allrecipes.1', 'allrecipes.10', 'allrecipes.11', 'allrecipes.12'},
    },
    'online_mind2web': {
        'path': 'online_mind2web', 'image': 'onlineMind2WebImage',
        'prefix': 'ONLINE_MIND2WEB', 'model': 'o4-mini', 'steps': 30,
        'tasks': {
            '512fd4deab099b8dc0dcfc0ec48a3c63', 'd9d8b7d84a3f8d057e368254fe8d65e2',
            '75a1b5dcd2c28508a971d98d51fe5767', '71f8de1834599fba443f40dbbfab8edd',
            '2207bb4f21786690cfed20b37253fb8b',
        },
    },
}


def suite_for(task):
    return task.split('@', 1)[0]


def capture_judge(env, output, plan):
    """Copy native evaluator state before agent.sample closes its environment."""
    suite = suite_for(plan['task'])
    native = env.unwrapped
    directory = output / 'judge-input'
    directory.mkdir(exist_ok=True)
    state = {'schema': 1, 'suite': suite, 'task_id': native._task_id,
             'task': native._task, 'max_steps': native.max_steps,
             'model': WEB_SUITES[suite]['model'], 'images': []}
    if suite == 'webharbor.webvoyager':
        state['agent_response'] = native._agent_response
        for index, data in enumerate(native._screenshots):
            name = f'judge-input/{index:04d}.png'
            (output / name).write_bytes(data)
            state['images'].append(name)
    else:
        state['trajectory_steps'] = native._trajectory_steps
        state['agent_final_answer'] = native._agent_final_answer
        for index, source in enumerate(native._image_paths):
            name = f'judge-input/{index:04d}.png'
            shutil.copyfile(source, output / name)
            state['images'].append(name)
        if native.result_path:
            shutil.copyfile(native.result_path, directory / 'native-result.json')
    write(output / 'judge-input.json', state)
