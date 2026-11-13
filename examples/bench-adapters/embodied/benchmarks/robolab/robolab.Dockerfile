ARG ISAACLAB_BASE=nvcr.io/nvidia/isaac-lab@sha256:b4d8e96cbfb9a6c40067bec6cc5ee180e36d4c0164b25f7215c5f47e31897b94
FROM ${ISAACLAB_BASE}
USER 0:0
COPY --from=robolab /robolab /opt/robolab/robolab
COPY --from=robolab /policies /opt/robolab/policies
COPY --from=robolab /dashboard /opt/robolab/dashboard
COPY --from=robolab /pyproject.toml /README.md /LICENSE /opt/robolab/
COPY examples/sdk/orbit_embodied /opt/orbit-sdk/orbit_embodied
COPY examples/bench-adapters/embodied/fixtures/hold_robolab.py /opt/orbit/hold_robolab.py
WORKDIR /opt/robolab
RUN /workspace/isaaclab/_isaac_sim/python.sh -c 'from importlib.metadata import version; print("\n".join(name + "==" + version(name) for name in ("numpy", "torch", "torchvision", "gymnasium", "isaaclab")))' > /tmp/isaac-constraints.txt && \
    /workspace/isaaclab/_isaac_sim/python.sh -m pip install --no-cache-dir \
    -c /tmp/isaac-constraints.txt -e . imageio-ffmpeg==0.6.0 docstring-parser==0.16
ENV OMNI_KIT_ACCEPT_EULA=YES ACCEPT_EULA=Y \
    PYTHONUNBUFFERED=1 PYTHONPATH=/opt/orbit-sdk NVIDIA_DRIVER_CAPABILITIES=graphics,compute,utility
ENTRYPOINT ["/workspace/isaaclab/_isaac_sim/python.sh"]
