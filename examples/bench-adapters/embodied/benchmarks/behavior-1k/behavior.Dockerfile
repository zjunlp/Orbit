ARG BEHAVIOR_BASE
FROM ${BEHAVIOR_BASE}
LABEL org.orbit.behavior.source="b544acbbb76b461349bcba21f93b870b11da6608"
RUN test "$(git -C /behavior-src rev-parse HEAD)" = "b544acbbb76b461349bcba21f93b870b11da6608" \
    && git -C /behavior-src diff --quiet HEAD -- OmniGibson bddl3 joylo
ENV OMNIGIBSON_HEADLESS=True OMNIGIBSON_DATA_PATH=/behavior-data OMNIGIBSON_APPDATA_PATH=/tmp/behavior-appdata
ENTRYPOINT ["/opt/conda/envs/behavior/bin/python"]
