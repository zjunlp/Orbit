ARG POLICY_BASE
FROM ${POLICY_BASE}

COPY --from=starvla / /opt/starvla/
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/starvla/serve_starvla.py /opt/orbit/serve_starvla.py
WORKDIR /opt/starvla
ENV PYTHONPATH=/opt/starvla:/opt/orbit-sdk HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
ENTRYPOINT ["python", "/opt/orbit/serve_starvla.py"]
