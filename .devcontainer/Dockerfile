FROM node:24-bookworm

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV SHELL=/bin/bash
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apt-get update \
    && apt-get install -y --no-install-recommends screen \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && pnpm setup \
    && pnpm install -g @github/copilot @anthropic-ai/claude-code @openai/codex \
    && pnpm add turbo --save-dev --ignore-workspace-root-check \
    && pnpm approve-builds --all -g \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y