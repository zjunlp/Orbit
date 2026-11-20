ARG BEHAVIOR_BASE
FROM ${BEHAVIOR_BASE}
ARG BEHAVIOR_SOURCE
RUN test "${BEHAVIOR_SOURCE}" = "b544acbbb76b461349bcba21f93b870b11da6608" \
    && test -d /behavior-src/OmniGibson/omnigibson
LABEL org.orbit.behavior.source="${BEHAVIOR_SOURCE}"
ENV OMNIGIBSON_HEADLESS=True OMNIGIBSON_DATA_PATH=/behavior-data OMNIGIBSON_APPDATA_PATH=/tmp/behavior-appdata
COPY --chmod=755 examples/bench-adapters/embodied/benchmarks/behavior-1k/behavior-python.sh /usr/local/bin/orbit-behavior-python
ENTRYPOINT ["/usr/local/bin/orbit-behavior-python"]
