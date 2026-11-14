ARG POLICY_BASE
FROM ${POLICY_BASE}
RUN python -c 'from importlib.metadata import version; assert version("lerobot") == "0.7.0"'
COPY examples/bench-adapters/embodied/policies/lingbot-vla-v2/serve_lingbot_v2.py /opt/orbit/serve_lingbot_v2.py
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
ENV PYTHONPATH=/opt/orbit-sdk HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false
ENTRYPOINT ["python", "/opt/orbit/serve_lingbot_v2.py"]
