ARG POLICY_BASE
FROM ${POLICY_BASE}
RUN --mount=type=bind,from=wheels,target=/wheels --mount=type=cache,target=/root/.cache/pip \
    python -m pip install numpy==1.26.4 transformers==4.57.6 diffusers==0.35.2 \
      accelerate==1.10.1 omegaconf==2.3.0 matplotlib==3.10.8 einops==0.8.1 imageio==2.37.2 \
      pyyaml==6.0.3 ftfy==6.3.1 easydict==1.13 regex==2025.11.3 sentencepiece==0.2.1 \
      opencv-python-headless==4.11.0.86 websockets==13.1 msgpack==1.1.0 msgpack-numpy==0.4.8 \
      /wheels/flash_attn-*.whl
COPY --from=policy_src / /opt/motus/
# The deployment imports common.py for tensor utilities. Its training rank helpers can use torch.distributed.
RUN file=/opt/motus/inference/robotwin/Motus/utils/common.py && \
    grep -Fxq 'import deepspeed.comm.comm as dist' "$file" && \
    sed -i 's/^import deepspeed\.comm\.comm as dist$/import torch.distributed as dist/' "$file"
# Load the T5 checkpoint on CPU before the encoder's existing move to its inference device.
RUN file=/opt/motus/inference/robotwin/Motus/bak/wan/modules/t5.py && \
    grep -Fxq '            device=device).eval().requires_grad_(False)' "$file" && \
    sed -i "s/^            device=device)\.eval()\.requires_grad_(False)$/            device='cpu').eval().requires_grad_(False)/" "$file"
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/motus/serve_motus.py /opt/orbit/serve_motus.py
ENV PYTHONPATH=/opt/motus/inference/robotwin/Motus:/opt/orbit-sdk HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
ENTRYPOINT ["python", "/opt/orbit/serve_motus.py"]
