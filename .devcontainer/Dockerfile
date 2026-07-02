FROM node:24-bookworm

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ENV npm_config_registry=https://registry.npmmirror.com
ENV RUSTUP_DIST_SERVER=https://rsproxy.cn
ENV RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup
ENV SHELL=/bin/bash
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"

RUN apt-get update \
    && apt-get install -y --no-install-recommends screen \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && pnpm config set registry https://registry.npmmirror.com \
    && pnpm install -g --registry=https://registry.npmmirror.com @github/copilot @anthropic-ai/claude-code @openai/codex \
    && pnpm add turbo --save-dev --ignore-workspace-root-check --registry=https://registry.npmmirror.com \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
