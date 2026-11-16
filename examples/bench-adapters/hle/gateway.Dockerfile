FROM python:3.12.11-slim-trixie@sha256:47ae396f09c1303b8653019811a8498470603d7ffefc29cb07c88f1f8cb3d19f
RUN python -m pip install --no-cache-dir trafilatura==2.0.0 pymupdf==1.26.6 \
    openai==2.26.0 pydantic==2.12.5 numpy==2.4.6 datasets==4.8.4 tqdm==4.67.1
ENV PYTHONDONTWRITEBYTECODE=1
WORKDIR /workspace
