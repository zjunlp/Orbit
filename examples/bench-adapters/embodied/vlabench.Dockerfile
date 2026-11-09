ARG BENCHMARK_BASE
FROM ${BENCHMARK_BASE}

COPY --from=vlabench /VLABench /opt/vlabench/VLABench
COPY --from=rrt /rrt_algorithms /opt/vlabench/rrt_algorithms
RUN pip install --no-cache-dir numpy==1.25.0 scipy==1.14.0 mujoco==3.2.2 dm-control==1.0.22 \
    'opencv-python-headless<4.12' open3d==0.18.0 'scikit-learn<1.7' 'openai<3' \
    colorlog==6.9.0 colorama==0.4.6 rtree==1.2.0 networkx==3.4.2 websockets==13.1 \
    && ln -s /opt/vlabench-assets/obj /opt/vlabench/VLABench/assets/obj \
    && ln -s /opt/vlabench-assets/scenes /opt/vlabench/VLABench/assets/scenes
COPY examples/bench-adapters/embodied/prepare_vlabench.py /opt/orbit/prepare_vlabench.py
RUN python /opt/orbit/prepare_vlabench.py /opt/vlabench/VLABench
ENV PYTHONPATH=/opt/vlabench
