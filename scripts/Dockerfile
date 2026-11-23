# ==============================================================================
# Dockerfile для воспроизводимой кросс-компиляции тулчейна (iec2c + tcc)
# под все целевые платформы из единого чистого окружения Ubuntu 24.04.
#
# Запуск:
#   docker build -t softplc-builder .
#   docker run --rm -v "$(pwd)/bin:/out" softplc-builder
# ==============================================================================
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    build-essential \
    autoconf \
    automake \
    flex \
    bison \
    gcc-aarch64-linux-gnu \
    g++-aarch64-linux-gnu \
    gcc-arm-linux-gnueabihf \
    g++-arm-linux-gnueabihf \
    mingw-w64 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /builder
COPY build_toolchain.sh /builder/build_toolchain.sh
RUN chmod +x /builder/build_toolchain.sh

CMD ["/bin/bash", "-c", "./build_toolchain.sh && cp -r /builder/bin/* /out/"]
