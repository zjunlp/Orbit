ARG SIMULATOR_BASE
FROM ${SIMULATOR_BASE}
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install 'pybullet==3.2.7' 'numpy-quaternion==2023.0.4' 'rich==13.9.4' 'websockets==13.1'
COPY --from=pyfasthash / /opt/pyfasthash
RUN --mount=type=cache,target=/root/.cache/pip pip install /opt/pyfasthash
COPY --from=calvin /calvin_env/calvin_env /opt/calvin/env/calvin_env
# Preserve the upstream provenance log when the image carries a source export.
RUN source=/opt/calvin/env/calvin_env/envs/play_table_env.py && \
    echo "dc19a40e856c99265d90c9a4ac99c58c8661b76bef68c639984ef6d80711ab60  $source" | sha256sum -c - && \
    sed -i 's/{get_git_commit_hash(Path(calvin_env.__file__))}/1431a46bd36bde5903fb6345e68b5ccc30def666/' "$source"
COPY --from=calvin /calvin_env/data /opt/calvin/env/data
COPY --from=calvin /calvin_env/conf /opt/calvin/env/conf
COPY --from=calvin /calvin_models/calvin_agent /opt/calvin/agent/calvin_agent
COPY --from=calvin /calvin_models/conf /opt/calvin/agent/conf
COPY --from=rlinf /rlinf/envs/sim/calvin/calvin_cfg /opt/calvin/scene
COPY --from=rlinf /rlinf/envs/sim/calvin/utils.py /opt/calvin/rlinf_sequences.py
COPY examples/bench-adapters/embodied/calvin_catalog.py /opt/calvin/catalog.py
RUN printf '%s\n' /opt/calvin/env /opt/calvin/agent > /usr/local/lib/python3.10/site-packages/calvin-source.pth
ENV PYOPENGL_PLATFORM=egl
ENTRYPOINT ["python"]
