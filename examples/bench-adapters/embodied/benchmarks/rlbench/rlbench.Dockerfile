# CoppeliaSim Edu is supplied as a local context; build and use it under its licence.
FROM python:3.10-slim-bookworm@sha256:5be5aaecb962a41567bc8041f1e9e3432cb085b037fe057f9a562630b2e4b370 AS simulator
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends \
    build-essential libgl1 libglx-mesa0 libgl1-mesa-dri libglib2.0-0 libdbus-1-3 libfontconfig1 \
    libxkbcommon-x11-0 libxcb-xinerama0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-render-util0 \
    libxrender1 libsm6 xvfb xauth && rm -rf /var/lib/apt/lists/*
COPY --from=coppeliasim / /opt/coppeliasim
RUN ln -sf libcoppeliaSim.so /opt/coppeliasim/libcoppeliaSim.so.1
ENV COPPELIASIM_ROOT=/opt/coppeliasim LD_LIBRARY_PATH=/opt/coppeliasim \
    QT_QPA_PLATFORM_PLUGIN_PATH=/opt/coppeliasim/platforms QT_PLUGIN_PATH=/opt/coppeliasim \
    QT_QPA_PLATFORM=xcb LIBGL_ALWAYS_SOFTWARE=1 PYTHONUNBUFFERED=1
COPY --from=pyrep / /opt/pyrep-source
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install numpy==1.26.4 scipy==1.15.3 pillow==11.3.0 cffi==1.17.1 gymnasium==0.29.1 \
    natsort==8.4.0 pyquaternion==0.9.9 imageio==2.37.0 imageio-ffmpeg==0.6.0 \
    msgpack==1.1.0 msgpack-numpy==0.4.8 websockets==13.1 setuptools==70.3.0 wheel==0.45.1 && \
    pip install --no-build-isolation --no-deps /opt/pyrep-source
COPY --from=rlbench /rlbench /opt/rlbench-source/rlbench
RUN printf '%s\n' /opt/rlbench-source > /usr/local/lib/python3.10/site-packages/rlbench-source.pth
COPY --chmod=755 examples/bench-adapters/embodied/benchmarks/rlbench/rlbench-python.sh /usr/local/bin/rlbench-python
ENTRYPOINT ["/usr/local/bin/rlbench-python"]

FROM simulator AS rvt-simulator
COPY --from=rvt /rvt/utils/rlbench_planning.py /opt/rvt/rvt/utils/rlbench_planning.py
RUN printf '%s\n' /opt/rvt > /usr/local/lib/python3.10/site-packages/rvt-source.pth
