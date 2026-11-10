ARG OPENWAM_BASE
FROM ${OPENWAM_BASE}

USER root
ENV LD_PRELOAD="" HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
RUN python -m pip install --no-cache-dir msgpack==1.1.0 msgpack-numpy==0.4.8
COPY examples/sdk/orbit_embodied /opt/orbit/python/orbit_embodied
COPY examples/bench-adapters/embodied/serve_openwam.py /opt/orbit/serve_openwam.py
ENV PYTHONPATH=/opt/orbit/python:/opt/openwam
USER 1000:1000
ENTRYPOINT ["/opt/venv/bin/python", "/opt/orbit/serve_openwam.py"]
