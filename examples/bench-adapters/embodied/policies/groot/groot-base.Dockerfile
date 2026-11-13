FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libegl1 libglib2.0-0 libgomp1 && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install torch==2.9.0 torchvision==0.24.0 --index-url https://download.pytorch.org/whl/cu128
COPY examples/bench-adapters/embodied/policies/groot/requirements-groot.txt /opt/requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip pip install -r /opt/requirements.txt
ENV PYTHONUNBUFFERED=1
