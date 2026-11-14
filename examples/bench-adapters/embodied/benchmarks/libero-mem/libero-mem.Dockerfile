ARG BENCHMARK_BASE
FROM ${BENCHMARK_BASE}
COPY --from=libero_mem /libero/libero /opt/libero-mem/libero/libero
COPY --from=libero_mem /thirdparty/robosuite/robosuite /opt/libero-mem/robosuite
COPY --from=mem_states / /opt/libero-mem/libero/libero/init_files/libero_mem/
ENV LIBERO_CONFIG_PATH=/etc/orbit/libero-mem \
    PYTHONPATH=/opt/libero-mem:/app/packages/openpi-client/src
RUN mkdir -p "$LIBERO_CONFIG_PATH" /opt/libero-mem/datasets && \
    printf '%s\n' 'benchmark_root: /opt/libero-mem/libero/libero' \
      'bddl_files: /opt/libero-mem/libero/libero/bddl_files' \
      'init_states: /opt/libero-mem/libero/libero/init_files' \
      'datasets: /opt/libero-mem/datasets' \
      'assets: /opt/libero-mem/libero/libero/assets' > "$LIBERO_CONFIG_PATH/config.yaml" && \
    /opt/fast-wam-libero/bin/python -c 'from libero.libero.envs import OffScreenRenderEnv'
ENTRYPOINT ["/opt/fast-wam-libero/bin/python"]
