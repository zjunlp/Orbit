FROM python:3.12.13-slim-bookworm
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends \
    gcc libc6-dev linux-libc-dev libglib2.0-0 libgomp1 && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install 'torch==2.7.1' 'torchvision==0.22.1' 'torchcodec==0.5.0' \
    'lerobot[smolvla]==0.5.1' 'transformers==5.3.0' \
    'msgpack==1.1.0' 'msgpack-numpy==0.4.8' 'websockets==13.1' && pip check
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/serve_lerobot.py /opt/orbit/serve_lerobot.py
ENV PYTHONPATH=/opt/orbit-sdk HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
    TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1 OMP_NUM_THREADS=4
ENTRYPOINT ["python", "/opt/orbit/serve_lerobot.py"]
