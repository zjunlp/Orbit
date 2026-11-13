ARG POLICY_BASE
FROM ${POLICY_BASE}

COPY --from=opendm / /opt/opendm/
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install /opt/opendm albumentations==2.0.8 opencv-python-headless==4.11.0.86 pyarrow==21.0.0 \
    websockets==13.1 msgpack==1.1.0 msgpack-numpy==0.4.8
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/dm05/serve_dm05.py /opt/orbit/serve_dm05.py
ENV PYTHONPATH=/opt/opendm/playground:/opt/orbit-sdk HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 NO_ALBUMENTATIONS_UPDATE=1
ENTRYPOINT ["python", "/opt/orbit/serve_dm05.py"]
