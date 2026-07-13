# syntax=docker/dockerfile:1.7
# Supply Node and Corepack from a digest-pinned source without inheriting its
# Debian package base; the Factory toolchain must match the Ubuntu CI runner.
FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS node-source

FROM ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90 AS toolchain
COPY --from=node-source /usr/local /usr/local
RUN --mount=type=cache,target=/var/cache/apt \
    apt-get update \
    && apt-get install -y --no-install-recommends \
      genisoimage=9:1.1.11-3.5 \
      7zip=23.01+dfsg-11 \
      xorriso=1:1.5.6-1.1ubuntu3 \
      osslsigncode \
      gcc-mingw-w64-x86-64 \
      wimtools=1.14.4-1.1build2 \
    && rm -rf /var/lib/apt/lists/*

FROM toolchain AS runtime
WORKDIR /workspace
RUN corepack enable pnpm
CMD ["node", "/workspace/scripts/factory/factory-cli.mjs"]
