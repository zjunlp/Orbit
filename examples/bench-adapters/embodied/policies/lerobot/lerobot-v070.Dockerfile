ARG POLICY_BASE
FROM ${POLICY_BASE}
# The base's PyTorch development CLI caps Click below Hugging Face Hub's requirement.
RUN python -m pip uninstall --break-system-packages -y spin \
    && python -m venv --without-pip --system-site-packages /opt/orbit-lerobot
ENV PATH=/opt/orbit-lerobot/bin:$PATH
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install 'lerobot[smolvla,molmoact2,fastwam,lingbot-vla-v2]==0.7.0' \
    'msgpack==1.1.0' 'msgpack-numpy==0.4.8' 'websockets==13.1' && python -m pip check
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/lerobot/serve_lerobot.py /opt/orbit/serve_lerobot.py
ENV PYTHONPATH=/opt/orbit-sdk HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
    TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1 OMP_NUM_THREADS=4
ENTRYPOINT ["python", "/opt/orbit/serve_lerobot.py"]
