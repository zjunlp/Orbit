ARG POLICY_BASE
FROM ${POLICY_BASE}

COPY --from=lingbot / /opt/lingbot/
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/lingbot-vla/serve_lingbot.py /opt/orbit/serve_lingbot.py
WORKDIR /opt/lingbot
ENV PYTHONPATH=/opt/lingbot:/opt/orbit-sdk HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
ENTRYPOINT ["python", "/opt/orbit/serve_lingbot.py"]
