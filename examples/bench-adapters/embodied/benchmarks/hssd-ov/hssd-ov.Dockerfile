ARG BENCHMARK_BASE=pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime
FROM ${BENCHMARK_BASE} AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential git cmake ninja-build libjpeg-dev libglm-dev libegl1-mesa-dev \
    libgl1-mesa-dev xorg-dev freeglut3-dev ca-certificates && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir pip==24.0 setuptools==65.5.1 wheel==0.38.4 && \
    pip install --no-cache-dir --no-build-isolation gym==0.23.0
RUN pip install --no-cache-dir numpy==1.26.4 pillow==10.4.0 scikit-build-core==0.11.6 \
    pybind11==2.13.6 pyyaml==6.0.3 scipy==1.15.3 numpy-quaternion==2024.0.13 \
    omegaconf==2.3.0 hydra-core==1.3.2 opencv-python-headless==4.11.0.86 \
    imageio==2.37.0 imageio-ffmpeg==0.6.0 msgpack==1.1.0 msgpack-numpy==0.4.8 websockets==13.1
FROM dependencies AS habitat-builder
COPY --from=habitat_sim / /opt/habitat-sim/
COPY --from=imath / /opt/imath/
ARG BUILD_JOBS=8
RUN CMAKE_BUILD_PARALLEL_LEVEL="$BUILD_JOBS" HABITAT_BUILD_GUI_VIEWERS=OFF HABITAT_WITH_CUDA=OFF \
    HABITAT_WITH_AUDIO=OFF HABITAT_WITH_BULLET=OFF \
    pip wheel -Ccmake.define.FETCHCONTENT_SOURCE_DIR_IMATH=/opt/imath \
    --no-deps --no-build-isolation --wheel-dir /opt/wheels /opt/habitat-sim

FROM dependencies AS simulator
COPY --from=habitat-builder /opt/wheels/ /opt/wheels/
COPY --from=habitat_lab /habitat-lab/ /opt/habitat-lab/
RUN pip install --no-cache-dir /opt/wheels/habitat_sim-*.whl && pip install --no-cache-dir /opt/habitat-lab
COPY --from=stopwatch / /opt/stopwatch/
# This import is only needed by the upstream annotation for model observation batching.
RUN sed -i '/^from stopwatch.model.rollout import ObservationBatch$/d' /opt/stopwatch/stopwatch/eval/env.py && \
    python -c 'from pathlib import Path; import site; (Path(site.getsitepackages()[0]) / "stopwatch.pth").write_text("/opt/stopwatch\n")' && \
    python -c 'import habitat, habitat_sim; from stopwatch.eval.env import _habitat_config'
RUN mkdir -p /usr/share/glvnd/egl_vendor.d && \
    printf '%s\n' '{"file_format_version":"1.0.0","ICD":{"library_path":"libEGL_nvidia.so.0"}}' \
      > /usr/share/glvnd/egl_vendor.d/10_nvidia.json
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics,display \
    __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json
ENTRYPOINT ["python"]
