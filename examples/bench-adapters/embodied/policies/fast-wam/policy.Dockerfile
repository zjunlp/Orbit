ARG POLICY_BASE
FROM ${POLICY_BASE}

RUN python -m pip install --no-cache-dir accelerate==1.12.0 boto3==1.35.99 einops==0.8.1 gitpython==3.1.45 \
    hydra-core==1.3.2 imageio==2.37.0 numpy==2.2.6 pillow==12.0.0 regex==2025.11.3 \
    safetensors==0.5.3 termcolor==2.5.0 transformers==4.49.0 ftfy==6.3.1 \
    msgpack==1.1.0 msgpack-numpy==0.4.8 websockets==13.1
COPY --from=fastwam / /opt/fastwam/
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/fast-wam/serve_fast_wam.py /opt/orbit/serve_fast_wam.py
ENV PYTHONPATH=/opt/fastwam/src:/opt/orbit-sdk HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
    DIFFSYNTH_SKIP_DOWNLOAD=true TOKENIZERS_PARALLELISM=false GIT_PYTHON_REFRESH=quiet
WORKDIR /opt/fastwam
RUN python -c 'import fastwam.runtime; from fastwam.datasets.lerobot.processors import fastwam_processor'
ENTRYPOINT ["python", "/opt/orbit/serve_fast_wam.py"]
