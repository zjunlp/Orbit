ARG POLICY_BASE=orbit/robocasa365-policy:reference
FROM ${POLICY_BASE} AS dependencies
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /.venv/bin/python \
      albumentations==1.4.18 av==12.3.0 diffusers==0.30.2 dm-tree==0.1.8 \
      msgpack-numpy==0.4.8 peft==0.17.0 timm==1.0.14 transformers==4.51.3

FROM dependencies AS policy
COPY --from=flash /flash_attn-*.whl /tmp/wheels/
RUN set -- /tmp/wheels/flash_attn-*.whl; test "$#" = 1 && \
    printf '%s  %s\n' 22013b8c74a63fc70e69be1e10ff02e4ad8fec84a43600bdca67b434ed417113 "$1" | sha256sum -c - && \
    uv pip install --python /.venv/bin/python --no-deps "$1" && rm "$1"
COPY --from=groot /gr00t /opt/groot-n15/gr00t
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/groot/serve_groot_n15.py /opt/orbit/serve_groot_n15.py
ENV PYTHONPATH=/opt/orbit-sdk:/opt/groot-n15 \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 NO_ALBUMENTATIONS_UPDATE=1 \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN /.venv/bin/python -c 'import flash_attn; from gr00t.experiment.data_config import DATA_CONFIG_MAP; DATA_CONFIG_MAP["panda_omron"].transform()'
ENTRYPOINT ["/.venv/bin/python"]
