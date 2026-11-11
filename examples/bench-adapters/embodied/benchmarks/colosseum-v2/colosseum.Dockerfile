ARG SIMULATOR_BASE
FROM ${SIMULATOR_BASE}
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --disable-pip-version-check --timeout 120 termcolor==3.1.0 coacd==1.0.7
RUN --mount=type=cache,target=/root/.cache/pip \
    --mount=type=bind,from=colosseum,source=/wheels,target=/wheels \
    pip install --disable-pip-version-check --timeout 120 --find-links /wheels viser==1.0.16
RUN --mount=type=bind,from=colosseum,source=/mani_skill,target=/upstream \
    python -c 'from importlib.metadata import version; from importlib.util import find_spec; from pathlib import Path; from shutil import copytree, rmtree; assert version("mani_skill") == "3.0.0b22"; root = Path(find_spec("mani_skill").origin).parent; rmtree(root); copytree("/upstream", root)'
COPY --from=colosseum /examples/baselines/act_clip/eval_rgbd.py /opt/colosseum-v2/eval_rgbd.py
ENV MS_ASSET_DIR=/colosseum-assets PYTHONUNBUFFERED=1 NVIDIA_DRIVER_CAPABILITIES=graphics,compute,utility
RUN python -c 'import mani_skill.envs; from mani_skill.envs.tasks.tabletop.colosseum_v2 import MAX_EPISODE_STEPS_BY_TASK; assert len(MAX_EPISODE_STEPS_BY_TASK) == 28'
ENTRYPOINT ["python"]
