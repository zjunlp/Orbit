ARG BENCHMARK_BASE=orbit/robomimic:reference
FROM ${BENCHMARK_BASE}
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install bddl==3.6.0 cloudpickle==3.1.1 easydict==1.13 gym==0.26.2 mujoco==3.5.0
COPY --from=arena /vla_arena /opt/vla-arena/vla_arena
RUN printf '/opt/vla-arena\n' > /usr/local/lib/python3.11/site-packages/vla-arena-source.pth
ENTRYPOINT ["python"]
