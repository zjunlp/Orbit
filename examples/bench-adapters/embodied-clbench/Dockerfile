FROM python:3.11-slim-bookworm
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG PIP_DEFAULT_TIMEOUT=120
RUN pip install --no-cache-dir 'mcp==1.27.0' 'pillow==11.3.0' 'requests==2.32.5' 'pyyaml==6.0.3'
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /workspace
