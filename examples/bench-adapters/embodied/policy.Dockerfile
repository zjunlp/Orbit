ARG POLICY_BASE
FROM ${POLICY_BASE}

# The dependency base comes from OpenPI's pinned serving Dockerfile.
COPY --from=openpi /src /app/src
COPY --from=openpi /packages/openpi-client /app/packages/openpi-client
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/serve_openpi.py /opt/orbit/serve_openpi.py
ENV PYTHONPATH=/opt/orbit-sdk:/app/src:/app/packages/openpi-client/src
ENV OPENPI_DATA_HOME=/opt/openpi-cache
RUN /.venv/bin/python -c "from openpi.shared.download import maybe_download; maybe_download('gs://big_vision/paligemma_tokenizer.model', gs={'token': 'anon'})"
ENTRYPOINT ["/.venv/bin/python"]
