FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir cua==0.10.1 cua-sandbox==0.9.1 cua-bench==0.3.1 cua-agent==0.9.1 cua-core==0.3.2 cua-cli==0.10.1
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
