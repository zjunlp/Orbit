#!/usr/bin/env -S python3 -B
"""Copy a pinned native build context for an Orbit-managed backend image build."""
import argparse
from pathlib import Path
import shlex
import shutil

from adapter import checkout
from evidence import COMMIT
from web_suites import ONLINE_BUILD_VERSIONS, WEB_SUITES


def prepare(root, suite, destination):
    root, destination = Path(root).resolve(), Path(destination).resolve()
    checkout(root, COMMIT)
    if destination.exists():
        raise ValueError('Choose a new build-context directory; existing files are never replaced')
    source = root / 'lite/gym/envs' / WEB_SUITES[suite]['path'] / 'docker'
    shutil.copytree(source, destination)
    dockerfile = destination / 'Dockerfile'
    if suite == 'online_mind2web':
        original = dockerfile.read_text()
        marker = 'RUN pip install --no-cache-dir'
        if marker not in original:
            raise ValueError('Expected the pinned native Online-Mind2Web dependency install')
        constraints = destination / 'orbit-constraints.txt'
        constraints.write_text(''.join(f'{name}=={version}\n' for name, version in ONLINE_BUILD_VERSIONS.items()))
        dockerfile.write_text(original.replace(marker,
            'COPY orbit-constraints.txt /opt/orbit-constraints.txt\n'
            'ENV PIP_CONSTRAINT=/opt/orbit-constraints.txt\n\n' + marker, 1))
    with dockerfile.open('a') as stream:
        stream.write(f'\nLABEL orbit.cua-lite.source="{COMMIT}" orbit.cua-lite.suite="{suite}"\n')
        if suite == 'online_mind2web':
            for name, version in ONLINE_BUILD_VERSIONS.items():
                stream.write(f'LABEL orbit.cua-lite.{name}="{version}"\n')
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
