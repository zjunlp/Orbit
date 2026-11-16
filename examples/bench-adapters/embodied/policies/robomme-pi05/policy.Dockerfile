ARG POLICY_BASE
FROM ${POLICY_BASE}
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip uninstall --python /.venv/bin/python opencv-python opencv-python-headless && \
    uv pip install --python /.venv/bin/python \
      'jax[cuda12]==0.5.3' flax==0.10.2 orbax-checkpoint==0.11.13 \
      tensorstore==0.1.74 ml-dtypes==0.4.1 transformers==4.53.2 h5py==3.13.0 \
      hydra-core==1.3.2 polars==1.40.1 mediapy==1.2.4 loguru==0.7.3 pytest==8.4.2 \
      opencv-python-headless==4.11.0.86 websockets==13.1 msgpack==1.1.0 msgpack-numpy==0.4.8
COPY --from=policy_src / /opt/robomme-policy/
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/robomme-pi05/serve_robomme_pi05.py /opt/orbit/serve_robomme_pi05.py
ENV PYTHONPATH=/opt/robomme-policy/src:/opt/robomme-policy/packages/openpi-client/src:/opt/orbit-sdk \
    XLA_PYTHON_CLIENT_PREALLOCATE=false HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
ENTRYPOINT ["/.venv/bin/python", "/opt/orbit/serve_robomme_pi05.py"]
