# syntax=docker/dockerfile:1
# Build the pinned upstream Dockerfile with its pinned submodules first.
ARG ROBODOJO_BASE
FROM ${ROBODOJO_BASE}
SHELL ["/bin/bash", "-c"]
COPY examples/bench-adapters/embodied/profiles/robodojo-native.json /opt/orbit/robodojo-native.json
COPY --from=runtime-manifest /robodojo-runtime.json /opt/orbit/robodojo-runtime.json
ARG RUNTIME_MANIFEST_DIGEST
RUN /root/miniconda3/envs/RoboDojo/bin/python -m pip uninstall -y vcs-versioning python-discovery httpx2 && \
    /root/miniconda3/envs/RoboDojo/bin/python -m pip install \
        psutil==5.9.8 wheel==0.43.0 pytest==8.3.5 virtualenv==20.26.6 setuptools-scm==8.2.0 \
        viser==0.2.7 tyro==0.9.17 typeguard==4.4.2 ipython==8.37.0 idna==3.10 \
        starlette==0.45.3 numpy==1.26.0 packaging==23.0 \
        typing_extensions==4.12.2 filelock==3.13.1 websockets==12.0 \
        imageio==2.37.0 imageio-ffmpeg==0.6.0 msgpack==1.1.1
RUN /root/miniconda3/envs/RoboDojo/bin/python - <<'PYTHON'
import hashlib, json, os, subprocess, sys
from importlib.metadata import version
from packaging.version import Version
from pathlib import Path
profile = json.loads(Path('/opt/orbit/robodojo-native.json').read_text())
runtime = json.loads(Path('/opt/orbit/robodojo-runtime.json').read_text())
checksum = 'sha256:' + hashlib.sha256(json.dumps(runtime, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
assert checksum == os.environ['RUNTIME_MANIFEST_DIGEST'], 'runtime manifest digest mismatch'
assert Version(version('isaacsim')) == Version(runtime['isaacsim']), 'unexpected Isaac Sim package'
expected_packages = {
    'torch': '2.7.0+cu128', 'torchvision': '0.22.0+cu128', 'torchaudio': '2.7.0+cu128',
    'numpy': '1.26.0', 'warp-lang': '1.11.0', 'scipy': '1.15.3', 'websockets': '12.0',
    'typing_extensions': '4.12.2', 'filelock': '3.13.1', 'packaging': '23.0', 'idna': '3.10',
}
for package, expected in expected_packages.items():
    assert Version(version(package)) == Version(expected), 'unexpected native dependency: ' + package
import torch
assert torch.version.cuda == '12.8', 'unexpected Torch CUDA build'
print('RoboDojo runtime versions:', json.dumps({**{name: version(name) for name in expected_packages},
                                               'isaacsim': version('isaacsim'), 'torch_cuda': torch.version.cuda}))
for key, commit in runtime['commits'].items():
    assert commit == profile['reference'][key]['commit'], 'unexpected dependency commit: ' + key
for relative, expected in {**profile['reference']['files'], **runtime['files']}.items():
    actual = 'sha256:' + hashlib.sha256((Path('/workspace/RoboDojo') / relative).read_bytes()).hexdigest()
    assert actual == expected, 'unexpected native source: ' + relative
checked = subprocess.run([sys.executable, '-m', 'pip', 'check'], capture_output=True, text=True)
print(checked.stdout, end='')
print(checked.stderr, end='', file=sys.stderr)
if checked.returncode:
    issues = checked.stdout.strip().splitlines()
    allowed = ' has requirement starlette==0.49.1, but you have starlette 0.45.3.'
    assert checked.returncode == 1 and issues and all(
        issue.startswith('isaaclab ') and issue.endswith(allowed) for issue in issues
    ), 'unexpected native dependency conflicts'
    print('Headless evaluation only: the pinned IsaacLab livestream dependency conflicts with Isaac Sim FastAPI.')
PYTHON
RUN printf '%s\n' /workspace/RoboDojo /workspace/RoboDojo/XPolicyLab > /root/miniconda3/envs/RoboDojo/lib/python3.11/site-packages/orbit-robodojo.pth
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/fixtures/hold_robodojo.py /opt/orbit/hold_robodojo.py
ENV NVIDIA_DRIVER_CAPABILITIES=all PYTHONUNBUFFERED=1 PYTHONPATH=/opt/orbit-sdk \
    LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu:/usr/local/cuda/lib64:${LD_LIBRARY_PATH}
RUN chmod o+x /root && /root/miniconda3/envs/RoboDojo/bin/python - <<'PYTHON'
import os
python = "/root/miniconda3/envs/RoboDojo/bin/python"
os.setgroups([])
os.setgid(65534)
os.setuid(65534)
os.execv(python, [python, "-c", "import numpy; import orbit_embodied; from orbit_embodied.wire import pack"])
PYTHON
LABEL org.orbit.robodojo.manifest="sha256:bfcc0a098c8ab50ad98615537948aae5eebd9df82ef2cde60a31c8dd22142dbc"
LABEL org.orbit.robodojo.runtime-manifest="${RUNTIME_MANIFEST_DIGEST}"
LABEL org.orbit.robodojo.scope="headless-evaluation; IsaacLab livestream/UI unsupported"
WORKDIR /workspace/RoboDojo
ENTRYPOINT ["/root/miniconda3/envs/RoboDojo/bin/python"]
