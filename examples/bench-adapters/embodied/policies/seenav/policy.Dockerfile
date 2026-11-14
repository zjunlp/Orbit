ARG POLICY_BASE
FROM ${POLICY_BASE}
RUN python -m pip install --no-cache-dir transformers==4.57.1 accelerate==1.11.0 \
    qwen-vl-utils==0.0.13 pillow==11.3.0 pydantic==2.11.9 msgpack==1.1.0 msgpack-numpy==0.4.8 websockets==13.1
COPY --from=seenav /SeeNav/planner/EBNavPlanner.py /opt/seenav/planner/EBNavPlanner.py
COPY --from=seenav /SeeNav/planner/utils/EBNav_planner_utils.py /opt/seenav/planner/utils/EBNav_planner_utils.py
COPY --from=seenav /SeeNav/envs/utils/EBNav_env_utils.py /opt/seenav/envs/utils/EBNav_env_utils.py
# The single-step recipe disables ICL. Orbit injects the local model after constructing the planner.
RUN sed -i '/^from planner.models.remote_model import RemoteModel$/d; \
    /^from envs.examples.ebnav_icl_examples.ebnav_visual_icl import create_example_json_list$/d; \
    /self.model = RemoteModel(/c\        self.model = None' /opt/seenav/planner/EBNavPlanner.py
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/seenav/serve_seenav.py /opt/orbit/serve_seenav.py
COPY examples/bench-adapters/embodied/policies/seenav/release.json /opt/orbit/release.json
ENV PYTHONPATH=/opt/orbit-sdk:/opt/seenav HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false
RUN --mount=type=bind,source=examples/bench-adapters/embodied/policies/seenav/test_seenav.py,target=/opt/orbit/test_seenav.py,readonly \
    python -c 'from transformers import Qwen2_5_VLForConditionalGeneration; from planner.EBNavPlanner import EBNavigationPlanner' && \
    cd /opt/orbit && python -B -m unittest -v test_seenav
ENTRYPOINT ["python", "/opt/orbit/serve_seenav.py"]
