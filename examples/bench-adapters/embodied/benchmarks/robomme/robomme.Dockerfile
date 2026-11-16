ARG SIMULATOR_BASE
FROM ${SIMULATOR_BASE}
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg git libegl1 libgl1 libglib2.0-0 libvulkan1 libxext6 libxrender1 && \
    rm -rf /var/lib/apt/lists/*
COPY --from=maniskill / /opt/maniskill/
COPY --from=robomme /src/robomme /opt/robomme-python/robomme/
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install /opt/maniskill \
      torch==2.9.1 torchvision==0.24.1 setuptools==80.9.0 \
      opencv-python-headless==4.11.0.86 matplotlib==3.10.8 sapien==3.0.2 \
      imageio-ffmpeg==0.6.0 websockets==13.1 msgpack==1.1.0 msgpack-numpy==0.4.8
RUN printf '%s\n' /opt/robomme-python > "$(python -c 'import site; print(site.getsitepackages()[0])')/orbit-robomme.pth" && \
    mkdir -m 700 -p /tmp/robomme-runtime
ENV XDG_RUNTIME_DIR=/tmp/robomme-runtime SAPIEN_RENDER_DEVICE=cuda MPLBACKEND=Agg \
    NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility,video
ENTRYPOINT ["python"]
