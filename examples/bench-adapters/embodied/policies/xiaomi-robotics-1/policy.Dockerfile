ARG POLICY_BASE
FROM ${POLICY_BASE}
RUN python -m pip install --no-cache-dir transformers==4.57.1 einops==0.8.1 \
    pillow==11.3.0 imageio==2.37.0 msgpack==1.1.0 msgpack-numpy==0.4.8 websockets==13.1
COPY --from=xiaomi /deploy /opt/xiaomi/deploy
COPY --from=xiaomi /eval_robocasa365 /opt/xiaomi/eval_robocasa365
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/xiaomi-robotics-1/serve_xiaomi.py /opt/orbit/serve_xiaomi.py
COPY examples/bench-adapters/embodied/policies/xiaomi-robotics-1/release.json /opt/orbit/release.json
ENV PYTHONPATH=/opt/orbit-sdk:/opt/xiaomi HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false
RUN python -c 'import torch, flash_attn, sys; from eval_robocasa365 import entry; assert sys.version_info[:2] == (3, 12) and torch.__version__ == "2.8.0+cu128" and flash_attn.__version__ == "2.8.3"'
ENTRYPOINT ["python", "/opt/orbit/serve_xiaomi.py"]
