ARG BASE_IMAGE=executor-prebuilt
FROM ${BASE_IMAGE}

RUN mkdir -p /workspace /codex-home /claude-home \
    && chmod 0777 /workspace /codex-home /claude-home

WORKDIR /workspace
