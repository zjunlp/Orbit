ARG POLICY_BASE
FROM ${POLICY_BASE}

COPY --from=opendm / /opt/opendm/
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install --no-deps /opt/opendm && \
    python -m pip install transformers==5.3.0 accelerate==1.14.0 numpy==1.26.4 \
    safetensors==0.7.0 pillow==12.2.0 pyyaml==6.0.3 opencv-python-headless==4.11.0.86 \
    h5py==3.14.0 loguru==0.7.3 sentencepiece==0.2.1 \
    websockets==13.1 msgpack==1.1.0 msgpack-numpy==0.4.8
COPY --from=fastvla / /opt/fastvla/
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/fast-vla/serve_fast_vla.py /opt/orbit/serve_fast_vla.py
ENV PYTHONPATH=/opt/fastvla:/opt/orbit-sdk HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
ENTRYPOINT ["python", "/opt/orbit/serve_fast_vla.py"]
