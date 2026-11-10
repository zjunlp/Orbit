FROM python:3.13-slim-bookworm
RUN pip install --no-cache-dir uv==0.8.24
WORKDIR /opt/benchmark
COPY --from=upstream pyproject.toml uv.lock README.md ./
COPY --from=upstream automationbench ./automationbench
RUN uv sync --frozen --no-dev
ENV PATH="/opt/benchmark/.venv/bin:$PATH" PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY runtime.py /opt/orbit-adapter/runtime.py
