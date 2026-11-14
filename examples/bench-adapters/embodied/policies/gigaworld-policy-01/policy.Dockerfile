ARG POLICY_BASE
FROM scratch AS wheelhouse
FROM ${POLICY_BASE}
ARG OFFLINE_WHEELS=0
RUN --mount=type=bind,from=wheelhouse,target=/wheels \
    if [ "$OFFLINE_WHEELS" = "1" ]; then export PIP_NO_INDEX=1 PIP_FIND_LINKS=/wheels; fi && \
    python -m pip install --no-cache-dir accelerate==1.11.0 diffusers==0.36.0 transformers==4.57.1 tokenizers==0.22.2 \
    huggingface-hub==0.36.0 safetensors==0.6.2 pillow==11.3.0 sentencepiece==0.2.1 \
    protobuf==6.33.6 msgpack==1.1.0 msgpack-numpy==0.4.8 websockets==13.1
COPY --from=gigaworld /src /opt/gigaworld/src
COPY --from=gigaworld /experiment/robocasa/inference_server.py /opt/gigaworld/inference_server.py
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/gigaworld-policy-01/serve_gigaworld.py /opt/orbit/serve_gigaworld.py
COPY examples/bench-adapters/embodied/policies/gigaworld-policy-01/release.json /opt/orbit/release.json
ENV PYTHONPATH=/opt/orbit-sdk:/opt/gigaworld/src:/opt/gigaworld HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false
RUN python -c 'import torch, torchvision; from diffusers.models import AutoencoderKLWan; from transformers import UMT5EncoderModel; from world_action_model.models.transformer_wa_casual import CasualWorldActionTransformer; from inference_server import GWPPolicy; assert torch.__version__ == "2.8.0+cu128" and torchvision.__version__ == "0.23.0+cu128"'
ENTRYPOINT ["python", "/opt/orbit/serve_gigaworld.py"]
