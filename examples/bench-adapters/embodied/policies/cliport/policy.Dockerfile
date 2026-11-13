ARG POLICY_BASE
FROM ${POLICY_BASE}
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install numpy==1.26.4 kornia==0.4.1 opencv-python-headless==4.11.0.86 \
      meshcat==0.0.18 tornado==6.4.2 matplotlib==3.10.3 omegaconf==2.3.0 transforms3d==0.4.2 \
      pybullet==3.2.7 gym==0.26.2 imageio==2.37.0 ftfy==6.3.1 regex==2026.1.15 \
      pytorch-lightning==1.9.5 torchmetrics==0.11.4 transformers==4.48.3 \
      websockets==13.1 msgpack==1.1.0 msgpack-numpy==0.4.8
COPY --from=cliport /cliport /opt/cliport/cliport
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/cliport/serve_cliport.py /opt/orbit/serve_cliport.py
ENV PYTHONPATH=/opt/cliport:/opt/orbit-sdk HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "/opt/orbit/serve_cliport.py"]
