ARG POLICY_BASE
FROM ${POLICY_BASE}
COPY --from=lightnav / /opt/lightnav/
RUN pip install --no-cache-dir transformers==5.8.0 tokenizers==0.22.2 safetensors==0.7.0 \
    pyyaml==6.0.3 pillow==11.3.0 torchvision==0.24.0 numpy==2.2.6 \
    msgpack==1.1.0 msgpack-numpy==0.4.8 websockets==13.1 && \
    pip install --no-cache-dir --no-deps /opt/lightnav
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/lightnav-0/serve_lightnav.py examples/bench-adapters/embodied/policies/lightnav-0/release.json /opt/orbit/
ENV PYTHONPATH=/opt/orbit-sdk VLN_EVAL_TEMPERATURE=0.0 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false
RUN python -c 'from lightnav.habitat.runner import build_velocity_policy; from transformers import Qwen3VLForConditionalGeneration'
ENTRYPOINT ["python", "/opt/orbit/serve_lightnav.py"]
