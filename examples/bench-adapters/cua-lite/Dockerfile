FROM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir browsergym-miniwob==0.14.3 playwright==1.44.0 gymnasium==0.29.1 \
    numpy==1.26.4 pillow==11.2.1 'mcp[cli]==1.6.0' pyyaml==6.0.2 \
    psutil==7.0.0 docker==7.1.0 uvicorn==0.34.2 fastapi==0.115.12 httpx==0.28.1 pydantic==2.10.6 jsonschema==4.26.0 openai==1.75.0
RUN printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/99orbit-build \
 && playwright install-deps chromium \
 && rm -f /etc/apt/apt.conf.d/99orbit-build \
 && rm -rf /var/lib/apt/lists/*
RUN PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=60000 playwright install chromium \
 && mv /root/.cache/ms-playwright /ms-playwright && chmod -R a+rX /ms-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
