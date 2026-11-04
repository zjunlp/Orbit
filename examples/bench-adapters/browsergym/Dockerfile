FROM python:3.11-slim-bookworm

ARG PIP_INDEX_URL=https://pypi.org/simple
ARG PIP_DEFAULT_TIMEOUT=120

RUN pip install --no-cache-dir browsergym-miniwob==0.14.3 \
        gymnasium==0.29.1 playwright==1.44.0 numpy==1.26.4 pillow==10.4.0 'mcp[cli]==1.6.0' pydantic==2.10.6 \
    && playwright install --with-deps chromium \
    && openssl version

RUN mv /root/.cache/ms-playwright /ms-playwright && chmod -R a+rX /ms-playwright

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
