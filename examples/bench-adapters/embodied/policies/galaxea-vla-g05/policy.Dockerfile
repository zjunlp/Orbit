ARG POLICY_BASE
FROM ${POLICY_BASE}
# The published preprocessor imports LeRobot's dataset recipe parser.
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install 'lerobot[dataset]==0.7.0' && python -m pip check
RUN --mount=type=bind,from=policy_src,source=/src/lerobot/policies/g05,target=/tmp/pinned-g05 \
    python -c 'from pathlib import Path; import lerobot.policies.g05 as g05; source = Path("/tmp/pinned-g05"); installed = Path(g05.__file__).parent; assert all((installed / path.name).read_bytes() == path.read_bytes() for path in source.glob("*.py"))' \
    && python -c 'from lerobot.datasets.recipe import TrainingRecipe; from lerobot.policies.g05.modeling_g05 import G05Policy'
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/galaxea-vla-g05/serve_g05.py /opt/orbit/serve_g05.py
ENV PYTHONPATH=/opt/orbit-sdk HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "/opt/orbit/serve_g05.py"]
