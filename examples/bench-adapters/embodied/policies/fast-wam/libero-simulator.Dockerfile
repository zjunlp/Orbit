ARG LIBERO_BASE
FROM ${LIBERO_BASE}

RUN UV_PYTHON_PREFERENCE=only-managed uv venv --python 3.10 /opt/fast-wam-libero && \
    uv pip install --python /opt/fast-wam-libero/bin/python \
      bddl==1.0.1 easydict==1.13 gym==0.25.2 h5py==3.12.1 imageio==2.37.0 imageio-ffmpeg==0.6.0 \
      mujoco==3.3.2 numpy==1.26.4 robosuite==1.4.1 scipy==1.13.1 \
      msgpack==1.1.0 msgpack-numpy==0.4.8 websockets==13.1 && \
    uv pip install --python /opt/fast-wam-libero/bin/python \
      --index https://download.pytorch.org/whl/cpu torch==2.5.1
RUN uv pip install --python /opt/fast-wam-libero/bin/python future==1.0.0 matplotlib==3.9.4
RUN /opt/fast-wam-libero/bin/python -c 'import mujoco; from libero.libero.envs import OffScreenRenderEnv; assert mujoco.__version__ == "3.3.2"'
# Orbit starts the CPU verifier as the host user, which cannot traverse /root.
RUN set -eu; python_path="$(readlink -f /opt/fast-wam-libero/bin/python)"; \
    cp -a "$(dirname "$(dirname "$python_path")")" /opt/fast-wam-python; \
    ln -sf "/opt/fast-wam-python/bin/${python_path##*/}" /opt/fast-wam-libero/bin/python; \
    ln -sf python /opt/fast-wam-libero/bin/python3; \
    ln -sf python /opt/fast-wam-libero/bin/python3.10
USER 1000:1000
RUN /opt/fast-wam-libero/bin/python -c 'import numpy'
USER root
ENTRYPOINT ["/opt/fast-wam-libero/bin/python"]
