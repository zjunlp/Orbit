# syntax=docker/dockerfile:1
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b
# The NVIDIA runtime injects the EGL vendor driver. Install only the GLVND dispatch libraries.
ADD --checksum=sha256:62e7bc8ccd47a60e55aad17f83d8d474310d782eb8589bbce2ab714c31712406 https://deb.debian.org/debian/pool/main/libg/libglvnd/libegl1_1.7.0-1+b2_amd64.deb /tmp/libegl1.deb
ADD --checksum=sha256:887f74008166549ce9e100c906aa937e95d6e5ce1c8d86efe8c95fd953359b9c https://deb.debian.org/debian/pool/main/libg/libglvnd/libglvnd0_1.7.0-1+b2_amd64.deb /tmp/libglvnd0.deb
ADD --checksum=sha256:50ea65a1141cbf6b02e41492963656ad0ba71d257cc4066ee9756bca7a6c1ac3 https://deb.debian.org/debian/pool/main/libg/libglvnd/libopengl0_1.7.0-1+b2_amd64.deb /tmp/libopengl0.deb
RUN for package in /tmp/*.deb; do dpkg-deb --extract "$package" /; done && ldconfig
RUN --mount=type=cache,target=/root/.cache/pip pip install uv==0.13.7
COPY --from=bigym2 / /opt/bigym2/
ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never PYTHONUNBUFFERED=1 NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility
WORKDIR /opt/bigym2
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable --python /usr/local/bin/python \
    && uv pip install imageio-ffmpeg==0.6.0 websockets==13.1 msgpack==1.1.0 msgpack-numpy==0.4.8
# Docker's legacy NVIDIA device injection can provide the driver without its GLVND descriptor.
RUN mkdir -p /usr/share/glvnd/egl_vendor.d \
    && printf '%s\n' '{"file_format_version":"1.0.0","ICD":{"library_path":"libEGL_nvidia.so.0"}}' \
       > /usr/share/glvnd/egl_vendor.d/10_nvidia.json
ENTRYPOINT ["/opt/bigym2/.venv/bin/python"]
