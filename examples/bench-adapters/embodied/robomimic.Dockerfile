FROM python:3.11-slim-bookworm@sha256:a83ba18aef0f865b1a4a611c2cf460fe446f2795673bbb9fe43be570439e3b39
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1 torchvision==0.20.1
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends \
    libegl1 libgl1 libosmesa6 libglib2.0-0 libgomp1 cmake g++ make libegl-dev && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install numpy==1.26.4 numba==0.60.0 scipy==1.13.1 mujoco==3.2.6 \
    mink==0.0.5 qpsolvers[quadprog]==4.6.0 opencv-python-headless==4.11.0.86 \
    Pillow==11.3.0 h5py==3.14.0 PyYAML==6.0.2 termcolor==3.1.0 tqdm==4.67.1 psutil==7.0.0 \
    imageio==2.37.0 imageio-ffmpeg==0.6.0 matplotlib==3.9.4 \
    transformers==4.41.2 huggingface-hub==0.23.4 msgpack==1.1.0 msgpack-numpy==0.4.8 websockets==13.1
RUN --mount=type=cache,target=/root/.cache/pip pip install --no-deps egl-probe==1.0.2
COPY --from=robomimic /robomimic /opt/robomimic/robomimic
COPY --from=robosuite /robosuite /opt/robosuite/robosuite
RUN printf '%s\n' /opt/robomimic /opt/robosuite > /usr/local/lib/python3.11/site-packages/robomimic-source.pth \
    && MUJOCO_GL=osmesa PYOPENGL_PLATFORM=osmesa python -c 'from robomimic.envs.env_robosuite import EnvRobosuite'
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python"]
