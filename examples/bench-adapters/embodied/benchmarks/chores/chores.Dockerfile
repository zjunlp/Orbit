ARG BENCHMARK_BASE=pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime
FROM ${BENCHMARK_BASE} AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git libvulkan1 vulkan-tools libxext6 libxcursor1 libxi6 libxrandr2 libxinerama1 \
    libxfixes3 libgl1 libnss3 libglib2.0-0 espeak-ng \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir pip==24.0 setuptools==65.5.1 wheel==0.38.4 && \
    pip install --no-cache-dir --no-build-isolation gym==0.21.0
RUN pip install --no-cache-dir \
    numpy==1.26.4 scipy==1.15.3 shapely==2.1.2 compress-pickle==2.1.0 compress-json==1.1.1 \
    prior==1.0.3 nltk==3.9.2 phonemizer==3.3.0 stringcase==1.2.0 \
    pyquaternion==0.9.9 opencv-python-headless==4.11.0.86 \
    imageio==2.37.0 imageio-ffmpeg==0.6.0 msgpack==1.1.0 msgpack-numpy==0.4.8 websockets==13.1 \
    attrs==25.4.0 h5py==3.14.0 omegaconf==2.3.0 wandb==0.21.3 plotly==6.3.0 \
    matplotlib==3.10.6 scikit-image==0.25.2 networkx==3.5 pandas==2.3.3 \
    setproctitle==1.3.7 ipdb==0.13.13 moviepy==1.0.3 av==15.1.0 \
    prettytable==3.16.0 shortuuid==1.0.13 timeout-decorator==0.5.0 scikit-video==1.1.11 \
    open-clip-torch==2.32.0 transformers==4.53.3 sentencepiece==0.2.1 \
    allenact==0.5.4 allenact-plugins==0.5.4
RUN pip install --no-cache-dir --extra-index-url https://ai2thor-pypi.allenai.org \
    ai2thor==0+966bd7758586e05d18f6181f459c0e90ba318bec
COPY --from=wordnet /wordnet.zip /wordnet2022.zip /opt/nltk_data/corpora/
RUN mkdir -p /etc/vulkan/icd.d && \
    printf '%s\n' '{"file_format_version":"1.0.0","ICD":{"library_path":"libEGL_nvidia.so.0","api_version":"1.2.175"}}' \
      > /etc/vulkan/icd.d/nvidia_icd.json
COPY --from=annotations /annotations.json.gz /opt/chores-annotations/annotations.json.gz
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics,display NLTK_DATA=/opt/nltk_data \
    OBJAVERSE_ASSETS_DIR=/chores/assets OBJAVERSE_ANNOTATIONS_PATH=/opt/chores-annotations/annotations.json.gz \
    OBJAVERSE_HOUSES_DIR=/chores/houses HOME=/opt/chores-home
COPY --from=flare / /opt/flare/
WORKDIR /opt/flare
RUN python -c 'from pathlib import Path; import site; (Path(site.getsitepackages()[0]) / "chores.pth").write_text("/opt/flare\n")' && \
    python -c 'from tasks.multi_task_eval_sampler import MultiTaskSampler'
ENTRYPOINT ["python"]

FROM dependencies AS simulator
COPY --from=thor / /opt/chores-home/.ai2thor/releases/thor-CloudRendering-966bd7758586e05d18f6181f459c0e90ba318bec/
