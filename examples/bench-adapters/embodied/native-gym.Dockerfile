FROM python:3.10-slim-bookworm
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libegl1 libgl1 libosmesa6 libglib2.0-0 libgomp1 libvulkan1 libxrender1 libsm6 git \
    build-essential cmake && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install numpy==1.26.4 scipy==1.15.3 gymnasium==0.29.1 sapien==2.2.2 \
    opencv-python-headless==4.10.0.84 transforms3d==0.4.2 imageio==2.37.0 \
    imageio-ffmpeg==0.6.0 msgpack==1.1.0 msgpack-numpy==0.4.8 pyzmq==26.2.0 \
    mujoco==3.3.1 robosuite==1.4.0 bddl==1.0.1 easydict==1.13 \
    gym==0.25.2 matplotlib==3.9.4 hydra-core==1.3.2 cloudpickle==3.1.1 \
    h5py==3.14.0 pyyaml==6.0.2 GitPython==3.1.45 tabulate==0.9.0 \
    gdown==5.2.0 trimesh==4.6.13 rtree==1.4.1 ruckig==0.12.2 setuptools==70.3.0
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu
COPY --from=groot /gr00t /opt/gr00t/gr00t
COPY --from=groot /LICENSE /opt/gr00t/LICENSE
COPY --from=groot /external_dependencies/LIBERO /opt/libero
COPY --from=groot /external_dependencies/SimplerEnv /opt/simpler
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/serve_groot.py /opt/orbit/serve_groot.py
COPY examples/bench-adapters/embodied/fixtures/zero_groot.py /opt/orbit-fixtures/zero_groot.py
RUN apt-get update && apt-get install -y --no-install-recommends \
    libx11-xcb1 libxcb-dri3-0 libxcb-present0 libxcb-randr0 libxcb-glx0 libxcb-sync1 libxcb-xfixes0 \
    && rm -rf /var/lib/apt/lists/*
COPY examples/bench-adapters/embodied/nvidia_icd.json /etc/vulkan/icd.d/nvidia_icd.json
COPY examples/bench-adapters/embodied/nvidia_egl.json /usr/share/glvnd/egl_vendor.d/10_nvidia.json
ENV PYTHONPATH=/opt/orbit-sdk:/opt/gr00t:/opt/libero:/opt/simpler:/opt/simpler/ManiSkill2_real2sim \
    MUJOCO_GL=egl PYOPENGL_PLATFORM=egl PYTHONUNBUFFERED=1 NVIDIA_DRIVER_CAPABILITIES=graphics,compute,utility
ENTRYPOINT ["python"]
