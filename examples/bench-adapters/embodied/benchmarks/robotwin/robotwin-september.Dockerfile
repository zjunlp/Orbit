ARG ROBOTWIN_BASE
FROM ${ROBOTWIN_BASE}
RUN rm -r /opt/robotwin/envs /opt/robotwin/description /opt/robotwin/task_config
COPY --from=robotwin /envs /opt/robotwin/envs
COPY --from=robotwin /env_cfg/task_config /opt/robotwin/env_cfg/task_config
COPY --from=robotwin /description /opt/robotwin/description
COPY --from=robotwin /data/decode_image_bit.py /opt/robotwin/data/decode_image_bit.py
RUN ln -s ../assets /opt/robotwin/envs/assets
