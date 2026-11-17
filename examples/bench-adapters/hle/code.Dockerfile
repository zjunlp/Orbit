FROM python:3.11.16-slim-bookworm@sha256:bad6508170f7d5af3cde529024b872d67f43b22f9bc796cc36587d416eea3693
COPY requirements-tools.txt /tmp/requirements-tools.txt
RUN python -m pip install --no-cache-dir -r /tmp/requirements-tools.txt \
    && rm /tmp/requirements-tools.txt
ENV PYTHONDONTWRITEBYTECODE=1
WORKDIR /workspace
