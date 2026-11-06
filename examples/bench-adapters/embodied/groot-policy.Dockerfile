ARG POLICY_BASE
FROM ${POLICY_BASE}
COPY --from=groot /gr00t /opt/gr00t/gr00t
COPY --from=groot /LICENSE /opt/gr00t/LICENSE
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/serve_groot.py /opt/orbit/serve_groot.py
ENV PYTHONPATH=/opt/orbit-sdk:/opt/gr00t \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false
ENTRYPOINT ["python"]
