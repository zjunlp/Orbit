ARG BENCHMARK_BASE
FROM ${BENCHMARK_BASE}

COPY --from=libero_plus /libero /opt/libero-plus/libero
RUN sed -i "s|http://|https://|g" /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/cuda-ubuntu2204-x86_64.list \
    && apt-get update && apt-get install -y --no-install-recommends libmagickwand-6.q16-6 \
    && rm -rf /var/lib/apt/lists/* \
    && uv pip install --python /.venv/bin/python wand==0.6.13 scikit-image==0.21.0 \
    && mkdir -p /etc/orbit/libero-plus \
    && printf '%s\n' 'benchmark_root: /opt/libero-plus/libero/libero' \
       'bddl_files: /opt/libero-plus/libero/libero/bddl_files' \
       'init_states: /opt/libero-plus/libero/libero/init_files' \
       'datasets: /opt/libero-plus/libero/datasets' \
       'assets: /opt/libero-plus/libero/libero/assets' > /etc/orbit/libero-plus/config.yaml
COPY examples/bench-adapters/embodied/prepare_libero_plus.py /opt/orbit/prepare_libero_plus.py
RUN /.venv/bin/python /opt/orbit/prepare_libero_plus.py /opt/libero-plus
RUN uv pip install --python /.venv/bin/python msgpack==1.1.0 msgpack-numpy==0.4.8
ENV PYTHONPATH=/opt/libero-plus:/app/packages/openpi-client/src \
    LIBERO_CONFIG_PATH=/etc/orbit/libero-plus
