ARG BENCHMARK_BASE
FROM ${BENCHMARK_BASE}
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvulkan1 vulkan-tools libx11-6 libxext6 libxcursor1 libxi6 libxrandr2 libxinerama1 \
    libxxf86vm1 libxfixes3 libgl1 libglib2.0-0t64 libnss3 python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/eb-navigation && /opt/eb-navigation/bin/pip install --no-cache-dir \
    ai2thor==5.0.0 gym==0.26.2 numpy==1.26.4 pillow==11.3.0 \
    opencv-python==4.11.0.86 imageio==2.37.0 imageio-ffmpeg==0.6.0 \
    msgpack==1.1.0 msgpack-numpy==0.4.8 websockets==13.1
COPY --from=eb_navigation /embodiedbench/envs/eb_navigation/datasets/*.json /opt/seenav/envs/datasets/
COPY --from=seenav /SeeNav/envs/EBNavEnv.py /opt/seenav/envs/EBNavEnv.py
COPY --from=seenav /verl-agent/agent_system/environments/env_package/ebnav/utils/ /opt/seenav/ActionMarker/
RUN mkdir -p /opt/seenav/DualViewGrounding/utils && \
    ln -s /opt/seenav/ActionMarker/utils.py /opt/seenav/DualViewGrounding/utils/bbox_utils.py && \
    mkdir -p /etc/vulkan/icd.d && \
    printf '%s\n' '{"file_format_version":"1.0.0","ICD":{"library_path":"libEGL_nvidia.so.0","api_version":"1.2.175"}}' \
      > /etc/vulkan/icd.d/nvidia_icd.json
COPY --from=thor / /opt/eb-navigation-home/.ai2thor/releases/thor-CloudRendering-f0825767cd50d69f666c7f282e54abfe58f1e917/
ENV HOME=/opt/eb-navigation-home NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics,display
RUN /opt/eb-navigation/bin/python -c 'import sys; sys.path.insert(0, "/opt/seenav"); from envs.EBNavEnv import EBNavigationEnv; from ActionMarker.ActionMarker import ActionMarker'
ENTRYPOINT ["/opt/eb-navigation/bin/python"]
