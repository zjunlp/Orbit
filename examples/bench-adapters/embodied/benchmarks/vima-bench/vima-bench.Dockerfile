FROM python:3.11-slim-bookworm@sha256:a83ba18aef0f865b1a4a611c2cf460fe446f2795673bbb9fe43be570439e3b39 AS simulator
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1 torchvision==0.20.1
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install numpy==1.23.5 pybullet==3.2.7 gym==0.23.1 opencv-python-headless==4.11.0.86 \
    einops==0.8.1 dm-tree==0.1.9 psutil==7.0.0 matplotlib==3.9.4 imageio==2.37.0 \
    imageio-ffmpeg==0.6.0 transforms3d==0.4.2 kornia==0.7.4 hydra-core==1.3.2 \
    tqdm==4.67.1 av==13.1.0 importlib-resources==5.12.0 msgpack==1.1.0 \
    msgpack-numpy==0.4.8 websockets==13.1
COPY --from=vima-bench /vima_bench /opt/vima-bench/vima_bench
RUN printf '%s\n' /opt/vima-bench > /usr/local/lib/python3.11/site-packages/vima-bench-source.pth \
    && python -c 'from vima_bench import ALL_TASKS; assert len(ALL_TASKS) == 17'
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python"]

FROM simulator AS policy
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install transformers==4.28.1 huggingface-hub==0.23.4
COPY --from=vima-policy /vima /opt/vima/vima
COPY --from=vima-policy /scripts/example.py /opt/vima/reference.py
RUN sed -i 's/Tokenizer.from_pretrained("t5-base")/Tokenizer.from_file(os.environ["VIMA_TOKENIZER"])/' /opt/vima/reference.py
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/vima/serve_vima.py /opt/vima/serve_vima.py
ENV PYTHONPATH=/opt/orbit-sdk:/opt/vima HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
