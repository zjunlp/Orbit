FROM python:3.11-slim-bookworm@sha256:a83ba18aef0f865b1a4a611c2cf460fe446f2795673bbb9fe43be570439e3b39
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends \
    libegl1 libgl1 libosmesa6 libglib2.0-0 libgomp1 libusb-1.0-0 libhidapi-hidraw0 && \
    rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --index-url https://download.pytorch.org/whl/cpu torch==2.7.1 torchvision==0.22.1
# pynput's Linux evdev dependency builds a wheel against the input headers.
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev linux-libc-dev && \
    rm -rf /var/lib/apt/lists/*
COPY --from=molmospaces / /opt/molmospaces
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install '/opt/molmospaces[mujoco]' 'mujoco==3.5.0' 'mujoco-warp==3.6.0'
COPY --from=wordnet / /usr/local/share/nltk_data/corpora/
ENV PYTHONUNBUFFERED=1 \
    NLTK_DATA=/usr/local/share/nltk_data \
    MLSPACES_ASSETS_DIR=/molmospaces/assets \
    MLSPACES_CACHE_DIR=/molmospaces/cache \
    MLSPACES_CACHE_LOCK=False
ENTRYPOINT ["python"]
