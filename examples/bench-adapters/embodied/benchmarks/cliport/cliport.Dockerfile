FROM python:3.8.20-slim-bookworm@sha256:1d52838af602b4b5a831beb13a0e4d073280665ea7be7f69ce2382f29c5a613f
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install uv==0.13.7
RUN --mount=type=cache,target=/root/.cache/uv --mount=from=torch-wheel,target=/wheels \
    uv pip install --system /wheels/torch-1.7.1+cpu-cp38-cp38-linux_x86_64.whl \
       numpy==1.23.5 pybullet==3.0.4 gym==0.17.3 kornia==0.4.1 \
       opencv-python-headless==4.11.0.86 scipy==1.10.1 transforms3d==0.3.1 \
       meshcat==0.0.18 tornado==6.4.2 matplotlib==3.7.5 omegaconf==2.3.0 imageio==2.35.1 imageio-ffmpeg==0.5.1 \
       websockets==13.1 msgpack==1.1.0 msgpack-numpy==0.4.8
COPY --from=cliport /cliport /opt/cliport/cliport
RUN sed -i '/^from cliport import agents$/d; /^from cliport import models$/d' /opt/cliport/cliport/__init__.py \
    && printf '%s\n' /opt/cliport > /usr/local/lib/python3.8/site-packages/cliport-source.pth \
    && python -c 'from cliport.environments.environment import Environment; from cliport.dataset import RavensMultiTaskDataset'
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python"]
