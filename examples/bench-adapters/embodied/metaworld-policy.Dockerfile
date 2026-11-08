ARG POLICY_BASE
FROM ${POLICY_BASE}
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /.venv/bin/python msgpack-numpy==0.4.8 websockets==13.1
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/serve_metaworld.py /opt/orbit/serve_metaworld.py
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 OPENPI_DATA_HOME=/opt/openpi-cache \
    TORCH_COMPILE_DISABLE=1 OMP_NUM_THREADS=4
ENTRYPOINT ["/.venv/bin/python", "/opt/orbit/serve_metaworld.py"]
