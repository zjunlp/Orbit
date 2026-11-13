ARG BENCHMARK_BASE
FROM ${BENCHMARK_BASE}

# Supply the audited OpenPI checkout as the named BuildKit context "openpi".
COPY --from=openpi /third_party/libero /app/third_party/libero
COPY --from=openpi /packages/openpi-client /app/packages/openpi-client
COPY examples/bench-adapters/embodied/fixtures/zero_policy.py /opt/orbit-fixtures/zero_policy.py
ENV PYTHONPATH=/app/packages/openpi-client/src:/app/third_party/libero
ENTRYPOINT ["/.venv/bin/python"]
