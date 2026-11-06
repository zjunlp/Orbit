ARG BENCHMARK_BASE
FROM ${BENCHMARK_BASE}
RUN uv pip install --python /.venv/bin/python \
    pyzmq==26.2.0 msgpack==1.1.0 msgpack-numpy==0.4.8
