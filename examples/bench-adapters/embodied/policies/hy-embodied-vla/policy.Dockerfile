ARG POLICY_BASE
FROM ${POLICY_BASE}
RUN --mount=type=bind,from=wheels,target=/wheels --mount=type=cache,target=/root/.cache/pip \
    python -m pip install numpy==1.26.4 transformers==4.57.6 timm==1.0.21 scipy==1.15.3 \
      einops==0.8.1 pyyaml==6.0.3 accelerate==1.10.1 opencv-python-headless==4.11.0.86 \
      websockets==13.1 msgpack==1.1.0 msgpack-numpy==0.4.8 \
      /wheels/flash_attn-*.whl
COPY --from=policy_src / /opt/hy-vla/
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/hy-embodied-vla/serve_hy_vla.py /opt/orbit/serve_hy_vla.py
ENV PYTHONPATH=/opt/hy-vla:/opt/orbit-sdk HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
ENTRYPOINT ["python", "/opt/orbit/serve_hy_vla.py"]
