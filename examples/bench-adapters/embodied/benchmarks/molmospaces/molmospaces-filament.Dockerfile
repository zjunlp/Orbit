ARG MOLMOSPACES_BASE
FROM ${MOLMOSPACES_BASE}
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvulkan1 libx11-xcb1 libxcb-dri3-0 && rm -rf /var/lib/apt/lists/*
COPY examples/bench-adapters/embodied/benchmarks/molmospaces/nvidia-egl-icd.json /opt/molmospaces/nvidia-egl-icd.json
RUN --mount=type=bind,from=wheel,target=/wheels \
    pip install --no-deps /wheels/*.whl && \
    python -c 'import mujoco; assert mujoco.mjRENDERER == "filament"'
ENV NVIDIA_DRIVER_CAPABILITIES=graphics,compute,utility \
    VK_ICD_FILENAMES=/opt/molmospaces/nvidia-egl-icd.json
