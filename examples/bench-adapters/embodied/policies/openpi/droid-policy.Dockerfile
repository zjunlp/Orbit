ARG POLICY_BASE
FROM ${POLICY_BASE}

RUN rm -rf /app/src /app/packages/openpi-client
COPY --from=openpi /src /app/src
COPY --from=openpi /packages/openpi-client /app/packages/openpi-client
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/openpi/serve_droid.py /opt/orbit/serve_droid.py
RUN --mount=type=bind,from=wire_wheels,source=/,target=/tmp/wheels \
    uv pip uninstall --python /.venv/bin/python opencv-python \
    && uv pip install --python /.venv/bin/python --no-index --find-links /tmp/wheels \
        --reinstall-package opencv-python-headless \
        'msgpack-numpy==0.4.8' 'pytest==8.4.2' 'opencv-python-headless==4.11.0.86'
ENV PYTHONPATH=/opt/orbit-sdk:/app/src:/app/packages/openpi-client/src
ENTRYPOINT ["/.venv/bin/python", "/opt/orbit/serve_droid.py"]
