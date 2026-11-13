ARG POLICY_BASE
FROM ${POLICY_BASE}

RUN python -m pip install --no-cache-dir accelerate==1.12.0 diffusers==0.36.0 einops==0.8.1 easydict==1.13 \
    ftfy==6.3.1 httpx==0.28.1 transformers==4.55.2 scipy==1.15.3 numpy==1.26.4 imageio==2.37.0 imageio-ffmpeg==0.6.0 \
    msgpack==1.1.0 msgpack-numpy==0.4.8 websockets==13.1 sentencepiece==0.2.1
COPY --from=lingbotva /wan_va /opt/lingbot-va/wan_va
# VA_Server explicitly requests Torch SDPA. Upstream eagerly imports flash-attn even in this mode.
RUN sed -i 's/from flash_attn import flash_attn_func/from importlib import import_module\n    def flash_attn_func(*args, **kwargs):\n        return import_module("flash_attn").flash_attn_func(*args, **kwargs)/' \
    /opt/lingbot-va/wan_va/modules/model.py
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/lingbot-va/serve_lingbot_va.py /opt/orbit/serve_lingbot_va.py
ENV PYTHONPATH=/opt/lingbot-va/wan_va:/opt/orbit-sdk HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
RUN python -c 'import wan_va_server'
ENTRYPOINT ["python", "/opt/orbit/serve_lingbot_va.py"]
