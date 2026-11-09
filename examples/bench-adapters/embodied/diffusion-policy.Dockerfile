ARG POLICY_BASE=orbit/robocasa365-policy:reference
ARG SIMULATOR_BASE=orbit/robocasa365-simulator:reference

FROM ${SIMULATOR_BASE} AS simulator
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system msgpack-numpy==0.4.8

FROM ${POLICY_BASE} AS policy
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /.venv/bin/python \
      diffusers==0.30.2 hydra-core==1.3.2 matplotlib==3.9.4 msgpack-numpy==0.4.8 \
      termcolor==2.5.0 transformers==4.51.3
COPY --from=diffusion /diffusion_policy /opt/diffusion/diffusion_policy
COPY --from=robomimic /robomimic /opt/robomimic/robomimic
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
ENV PYTHONPATH=/opt/orbit-sdk:/opt/diffusion:/opt/robomimic \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN /.venv/bin/python -c 'from diffusion_policy.policy.diffusion_transformer_hybrid_image_policy import DiffusionTransformerHybridImagePolicy; from robomimic.utils.obs_utils import process_frame'
COPY examples/bench-adapters/embodied/serve_diffusion_policy.py /opt/orbit/serve_diffusion_policy.py
ENTRYPOINT ["/.venv/bin/python"]
