FROM python:3.10-slim-bookworm@sha256:5be5aaecb962a41567bc8041f1e9e3432cb085b037fe057f9a562630b2e4b370
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libgomp1 && rm -rf /var/lib/apt/lists/*
ENV PIP_DEFAULT_TIMEOUT=120 PIP_RETRIES=5
COPY examples/bench-adapters/embodied/requirements-openvla.txt /opt/requirements.txt
COPY --from=transformers /setup.py /opt/transformers/setup.py
COPY --from=transformers /README.md /opt/transformers/README.md
COPY --from=transformers /LICENSE /opt/transformers/LICENSE
COPY --from=transformers /src /opt/transformers/src
COPY --from=dlimp /setup.py /opt/dlimp/setup.py
COPY --from=dlimp /README.md /opt/dlimp/README.md
COPY --from=dlimp /dlimp /opt/dlimp/dlimp
RUN --mount=type=cache,target=/root/.cache/pip \
    sed '/^transformers @ /d; /^dlimp @ /d' /opt/requirements.txt > /opt/dependencies.txt && \
    pip install --no-deps -r /opt/dependencies.txt && \
    pip install --no-deps /opt/transformers /opt/dlimp && pip check
COPY --from=openvla /prismatic /opt/openvla/prismatic
COPY --from=openvla /experiments /opt/openvla/experiments
COPY --from=openvla /LICENSE /opt/openvla/LICENSE
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/serve_openvla.py /opt/orbit/serve_openvla.py
COPY examples/bench-adapters/embodied/audit_openvla.py /opt/orbit/audit_openvla.py
ENV PYTHONPATH=/opt/orbit-sdk:/opt/openvla \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false \
    PYTHONUNBUFFERED=1 OMP_NUM_THREADS=4 TF_NUM_INTRAOP_THREADS=4 TF_NUM_INTEROP_THREADS=1
WORKDIR /opt/openvla
ENTRYPOINT ["python"]
