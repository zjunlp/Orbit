ARG SIMULATOR_BASE
FROM ${SIMULATOR_BASE} AS base
RUN --mount=type=cache,target=/root/.cache/pip pip install websockets==13.1

FROM base AS metaworld
RUN --mount=type=cache,target=/root/.cache/pip pip install 'metaworld==3.0.0' 'gymnasium==1.2.1' 'mujoco==3.3.7'

FROM base AS maniskill
RUN --mount=type=bind,from=torch_wheels,target=/wheels \
    pip install --no-index --find-links=/wheels 'torch==2.4.1+cu124'
RUN --mount=type=cache,target=/root/.cache/pip pip install 'mani_skill==3.0.0b22' 'sapien==3.0.3' 'gymnasium==0.29.1'
RUN --mount=type=bind,from=physx,source=linux-so.zip,target=/tmp/linux-so.zip \
    echo '167a01aad7381afef963b89169968c289e7b653880a7a823c116d87ee5c00fc6  /tmp/linux-so.zip' | sha256sum -c - && \
    python -m zipfile -e /tmp/linux-so.zip /root/.sapien/physx/105.1-physx-5.3.1.patch0
COPY --from=rlinf /rlinf/envs/sim/maniskill/tasks/put_on_in_scene_multi.py /opt/orbit/rlinf/orbit_maniskill_task.py
ENV PYTHONPATH=/opt/orbit/rlinf MS_ASSET_DIR=/maniskill-data MANISKILL_ASSET_DIR=/maniskill-data/rlinf
