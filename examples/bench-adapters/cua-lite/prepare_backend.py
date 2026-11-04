#!/usr/bin/env -S python3 -B
"""Copy a pinned native build context for an Orbit-managed backend image build."""
import argparse
from pathlib import Path
import shlex
import shutil

from adapter import checkout
from evidence import COMMIT
from web_suites import WEB_SUITES


def prepare(root, suite, destination):
    root, destination = Path(root).resolve(), Path(destination).resolve()
    checkout(root, COMMIT)
    if destination.exists():
        raise ValueError('Choose a new build-context directory; existing files are never replaced')
    source = root / 'lite/gym/envs' / WEB_SUITES[suite]['path'] / 'docker'
    shutil.copytree(source, destination)
    dockerfile = destination / 'Dockerfile'
    with dockerfile.open('a') as stream:
        stream.write(f'\nLABEL orbit.cua-lite.source="{COMMIT}" orbit.cua-lite.suite="{suite}"\n')
        stream.write('ENTRYPOINT []\nCMD ["/usr/local/bin/entrypoint.sh"]\n')
    return dockerfile


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('checkout', type=Path)
    parser.add_argument('suite', choices=WEB_SUITES)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    file = prepare(args.checkout, args.suite, args.destination)
    print('Native build context prepared. Build through Orbit, then register the successful Run imageId:')
    print(f'orbit run --dockerfile {shlex.quote(str(file))} --no-snapshot --root --cpus 2 --mem 4 '
          f'--timeout 10 -n {shlex.quote(args.suite + " backend image")} -- python -c '
          + shlex.quote('from pathlib import Path; assert Path("/usr/local/bin/server.py").is_file(); print("native backend installed")'))
