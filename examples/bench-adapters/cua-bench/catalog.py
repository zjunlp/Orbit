"""Extract the pinned task factories without importing optional GUI dependencies.

This runs the original pure tasks_config function and the upstream Task dataclass,
not setup/solve/evaluate. Execution always rechecks against cua_bench.make().
"""
import ast
import hashlib
from pathlib import Path
import runpy
from types import SimpleNamespace


def catalog(root):
    core = runpy.run_path(str(root / 'cua_bench/core.py'))
    images = runpy.run_path(str(root / 'cua_bench/images.py'))
    result = []
    for path in sorted((root / 'datasets').glob('*/**/main.py')):
        source = path.read_text()
        tree = ast.parse(source)
        functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and any(
            'tasks_config' in ast.unparse(d) for d in n.decorator_list)]
        if len(functions) != 1:
            raise ValueError(f'Expected one task factory: {path}')
        fn = functions[0]
        fn.decorator_list = []
        fn.returns = None
        nodes = [n for n in tree.body if isinstance(n, (ast.Assign, ast.AnnAssign))]
        namespace = {'__file__': str(path), 'Path': Path,
                     'cb': SimpleNamespace(Task=core['Task']), 'bench_image': images['image']}
        exec(compile(ast.Module(body=[*nodes, fn], type_ignores=[]), str(path), 'exec'), namespace)
        relative = path.parent.relative_to(root / 'datasets').as_posix()
        for variant, task in enumerate(namespace[fn.name]()):
            result.append({'id': f'{relative}@{variant}', 'path': relative, 'variant': variant,
                           'title': task.description, 'computer': task.computer,
                           'source_sha256': hashlib.sha256(source.encode()).hexdigest()})
    return result
