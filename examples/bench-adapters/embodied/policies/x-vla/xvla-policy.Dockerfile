ARG POLICY_BASE
ARG SIMULATOR_BASE=orbit/robotwin-simulator:reference

FROM ${SIMULATOR_BASE} AS simulator
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /.venv/bin/python 'msgpack-numpy==0.4.8'

FROM ${POLICY_BASE} AS policy
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m venv --system-site-packages /opt/xvla && \
    /opt/xvla/bin/pip install 'transformers==4.51.3' 'timm==1.0.12' 'scipy==1.15.0' \
    'fastapi==0.115.12' 'uvicorn==0.34.3' 'json_numpy==2.1.0'
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/x-vla/serve_xvla.py /opt/orbit/serve_xvla.py
ENTRYPOINT ["/opt/xvla/bin/python", "/opt/orbit/serve_xvla.py"]
