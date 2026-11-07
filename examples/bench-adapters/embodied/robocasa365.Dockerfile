ARG SIM_BASE=python:3.11-slim-bookworm
ARG POLICY_BASE=orbit/openpi-policy:reference

FROM ${POLICY_BASE} AS openpi-base

FROM ${SIM_BASE} AS simulator
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends \
    libegl1 libgl1 libosmesa6 libglib2.0-0 libgomp1 && rm -rf /var/lib/apt/lists/*
COPY examples/bench-adapters/embodied/requirements-robocasa365.txt /opt/orbit/requirements-robocasa365.txt
COPY --from=openpi-base /usr/bin/uv /usr/local/bin/uv
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system -r /opt/orbit/requirements-robocasa365.txt msgpack==1.1.0 websockets==13.1
COPY --from=robocasa /robocasa /opt/robocasa/robocasa
COPY --from=robosuite /robosuite /opt/robosuite/robosuite
COPY --from=openpi /packages/openpi-client /app/packages/openpi-client
RUN printf '%s\n' /opt/robocasa /opt/robosuite > /usr/local/lib/python3.11/site-packages/robocasa-source.pth
COPY examples/bench-adapters/embodied/nvidia_egl.json /usr/share/glvnd/egl_vendor.d/10_nvidia.json
ENV PYTHONUNBUFFERED=1 NVIDIA_DRIVER_CAPABILITIES=graphics,compute,utility
RUN MUJOCO_GL=osmesa python -c 'import robocasa; from robocasa.utils.dataset_registry import TARGET_TASKS; assert len(TARGET_TASKS["atomic_seen"]) == 18' && \
    rm -rf /opt/robocasa/robocasa/models/assets
ENTRYPOINT ["python"]

FROM openpi-base AS policy
RUN sed -i 's|http://|https://|g' /etc/apt/sources.list && \
    apt-get update && apt-get install -y --no-install-recommends \
    libegl1 libgl1 libosmesa6 libglib2.0-0 libgomp1 && rm -rf /var/lib/apt/lists/*
COPY examples/bench-adapters/embodied/requirements-robocasa365.txt /opt/orbit/requirements-robocasa365.txt
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /.venv/bin/python -r /opt/orbit/requirements-robocasa365.txt
COPY --from=robocasa /robocasa /opt/robocasa/robocasa
COPY --from=robosuite /robosuite /opt/robosuite/robosuite
COPY --from=openpi /src /opt/robocasa-openpi/src
COPY --from=openpi /packages/openpi-client /opt/robocasa-openpi/packages/openpi-client
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /.venv/bin/python pytest==8.3.5
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/serve_openpi.py /opt/orbit/serve_openpi.py
ENV MUJOCO_GL=osmesa PYOPENGL_PLATFORM=osmesa \
    PYTHONPATH=/opt/orbit-sdk:/opt/robocasa-openpi/src:/opt/robocasa-openpi/packages/openpi-client/src:/opt/robocasa:/opt/robosuite
RUN /.venv/bin/python -c 'from openpi.policies.policy_config import create_trained_policy; from openpi.training.config import get_config; get_config("pi05_pretrain_human300")'
ENTRYPOINT ["/.venv/bin/python"]
