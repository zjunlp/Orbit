FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea

# Only the dependencies imported by the text environments and evaluator; no voice or plotting.
RUN pip install --no-cache-dir \
    pydantic==2.11.7 pandas==2.2.3 deepdiff==8.4.2 loguru==0.7.3 \
    docstring-parser==0.16 python-dotenv==1.1.0 PyYAML==6.0.2 toml==0.10.2 \
    litellm==1.65.8 tenacity==9.1.2 rich==14.0.0

RUN pip install --no-cache-dir addict==2.4.0

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    LITELLM_LOCAL_MODEL_COST_MAP=True
WORKDIR /tmp
