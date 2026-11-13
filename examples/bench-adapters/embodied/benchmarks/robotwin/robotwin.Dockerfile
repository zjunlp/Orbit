ARG SIM_BASE=python:3.10-slim-bookworm
ARG CUDA_DEVEL=nvidia/cuda:12.4.1-devel-ubuntu22.04
ARG POLICY_BASE=orbit/openpi-policy:reference

FROM ${POLICY_BASE} AS openpi-base

FROM ${CUDA_DEVEL} AS cuda-toolkit

FROM scratch AS torch-wheels

FROM ${SIM_BASE} AS simulator-python
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends \
    build-essential libvulkan1 libgl1 libglib2.0-0 ffmpeg libx11-xcb1 libxcb-dri3-0 \
    libxcb-present0 libxcb-randr0 libxcb-glx0 libxcb-sync1 libxcb-xfixes0 && rm -rf /var/lib/apt/lists/*
COPY --from=openpi-base /usr/bin/uv /usr/local/bin/uv
RUN python3 -m venv /.venv
COPY examples/bench-adapters/embodied/benchmarks/robotwin/requirements-robotwin.txt /opt/orbit/requirements-robotwin.txt
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /.venv/bin/python -r /opt/orbit/requirements-robotwin.txt

FROM simulator-python AS simulator
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,from=torch-wheels,target=/opt/torch-wheels \
    uv pip install --python /.venv/bin/python --find-links /opt/torch-wheels \
        --index https://download.pytorch.org/whl/cu124 torch==2.4.1+cu124
COPY --from=curobo /src /opt/curobo/src
COPY --from=curobo /pyproject.toml /setup.cfg /setup.py /README.md /MANIFEST.in /opt/curobo/
ARG CUDA_ARCH=8.0
ARG CUDA_TOOLKIT_SOURCE=/usr/local/cuda-12.4
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,from=cuda-toolkit,source=${CUDA_TOOLKIT_SOURCE},target=/usr/local/cuda-12.4 \
    CUDA_HOME=/usr/local/cuda-12.4 TORCH_CUDA_ARCH_LIST="$CUDA_ARCH" MAX_JOBS=4 \
    SETUPTOOLS_SCM_PRETEND_VERSION=0.7.8 \
    uv pip install --python /.venv/bin/python --no-build-isolation \
        -c /opt/orbit/requirements-robotwin.txt /opt/curobo && \
    sed -i -E 's/("r")(\))( as)/\1, encoding="utf-8"\2\3/g' /.venv/lib/python3.10/site-packages/sapien/wrapper/urdf_loader.py && \
    sed -i 's/< 1e-4 or collide or not/< 1e-4 or not/' /.venv/lib/python3.10/site-packages/mplib/planner.py
COPY --from=robotwin /envs /opt/robotwin/envs
COPY --from=robotwin /task_config /opt/robotwin/task_config
COPY --from=robotwin /description /opt/robotwin/description
COPY --from=openpi /packages/openpi-client /app/packages/openpi-client
COPY examples/bench-adapters/embodied/runtime/nvidia_icd.json /usr/share/vulkan/icd.d/nvidia_icd.json
RUN ln -s ../assets ../task_config /opt/robotwin/envs/ && \
    printf '%s\n' /opt/robotwin /opt/robotwin/description/utils > /.venv/lib/python3.10/site-packages/robotwin.pth
RUN /.venv/bin/python -c 'import msgpack_numpy; from websockets.sync.client import connect'
ENV PYTHONUNBUFFERED=1 NVIDIA_DRIVER_CAPABILITIES=graphics,compute,utility
WORKDIR /opt/robotwin
ENTRYPOINT ["/.venv/bin/python"]

FROM openpi-base AS policy
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /.venv/bin/python pytest==8.3.5
COPY --from=openpi /src /opt/robotwin-openpi/src
COPY --from=openpi /pace/src /opt/robotwin-openpi/pace/src
COPY --from=openpi /packages/openpi-client /app/packages/openpi-client
COPY --from=tokenizer /tokenizer.model /opt/openpi-cache/big_vision/paligemma_tokenizer.model
RUN echo '8986bb4f423f07f8c7f70d0dbe3526fb2316056c17bae71b1ea975e77a168fc6  /opt/openpi-cache/big_vision/paligemma_tokenizer.model' | sha256sum --check
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/openpi/serve_openpi.py /opt/orbit/serve_openpi.py
ENV PYTHONPATH=/opt/orbit-sdk:/opt/robotwin-openpi/src:/opt/robotwin-openpi/pace/src:/app/packages/openpi-client/src \
    OPENPI_DATA_HOME=/opt/openpi-cache
RUN /.venv/bin/python -c 'from openpi.policies.policy_config import create_trained_policy; from openpi.training.config import get_config; assert get_config("pi05_robotwin_adjust_bottle").model.action_horizon == 50'
ENTRYPOINT ["/.venv/bin/python"]
