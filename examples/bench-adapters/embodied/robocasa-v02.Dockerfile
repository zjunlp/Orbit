# RoboCasa v0.2 and robosuite v1.5.0 source contexts are pinned by the configurator.
ARG BASE_IMAGE=python:3.11-slim-bookworm@sha256:a83ba18aef0f865b1a4a611c2cf460fe446f2795673bbb9fe43be570439e3b39
FROM ${BASE_IMAGE}
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends \
    libegl1 libgl1 libosmesa6 libglib2.0-0 libgomp1 && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install numpy==1.23.5 numba==0.57.1 scipy==1.12.0 mujoco==3.2.6 \
    mink==0.0.5 qpsolvers[quadprog]==4.6.0 opencv-python-headless==4.11.0.86 \
    Pillow==11.3.0 h5py==3.14.0 lxml==5.4.0 imageio==2.37.0 imageio-ffmpeg==0.6.0 \
    PyYAML==6.0.2 termcolor==3.1.0 tqdm==4.67.1 msgpack==1.1.0 \
    msgpack-numpy==0.4.8 websockets==13.1
COPY --from=robocasa /robocasa /opt/robocasa-v02/robocasa
COPY --from=robosuite /robosuite /opt/robosuite/robosuite
RUN printf '%s\n' /opt/robocasa-v02 /opt/robosuite > /usr/local/lib/python3.11/site-packages/robocasa-source.pth
RUN MUJOCO_GL=osmesa python -c 'import robocasa; import robosuite; assert (robocasa.__version__, robosuite.__version__) == ("0.2.0", "1.5.0")' \
    && rm -rf /opt/robocasa-v02/robocasa/models/assets
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python"]
