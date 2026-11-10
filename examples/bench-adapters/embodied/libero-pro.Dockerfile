ARG BENCHMARK_BASE
FROM ${BENCHMARK_BASE}
COPY --from=libero_pro / /opt/libero-pro/
COPY examples/bench-adapters/embodied/prepare_libero_pro.py /opt/orbit/prepare_libero_pro.py
ENV PYTHONPATH=/opt/libero-pro:/app/packages/openpi-client/src LIBERO_CONFIG_PATH=/etc/orbit/libero-pro
RUN mkdir -p "$LIBERO_CONFIG_PATH" /opt/libero-pro/datasets \
    && printf '%s\n' 'benchmark_root: /opt/libero-pro/libero/libero' \
       'bddl_files: /opt/libero-pro/libero/libero/bddl_files' \
       'init_states: /opt/libero-pro/libero/libero/init_files' \
       'datasets: /opt/libero-pro/datasets' \
       'assets: /opt/libero-pro/libero/libero/assets' > "$LIBERO_CONFIG_PATH/config.yaml" \
    && /.venv/bin/python -B /opt/orbit/prepare_libero_pro.py /opt/libero-pro/generated
ENTRYPOINT ["/.venv/bin/python"]
