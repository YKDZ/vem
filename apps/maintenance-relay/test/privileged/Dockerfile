FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    iproute2=6.1.0-3 \
    nftables=1.0.6-2+deb12u2 \
    procps=2:4.0.2-3 \
    wireguard-tools=1.0.20210914-1+b1 \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_OPTIONS="--conditions=vem-source"
ENV VEM_RELAY_PRIVILEGED_REQUIRED="1"
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/maintenance-relay/package.json apps/maintenance-relay/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN corepack enable \
  && pnpm install --frozen-lockfile \
    --filter maintenance-relay... \
    --filter @vem/shared...

COPY apps/maintenance-relay apps/maintenance-relay
COPY packages/shared packages/shared

WORKDIR /workspace/apps/maintenance-relay
CMD ["pnpm", "exec", "vitest", "run", "src/network-namespace.spec.ts"]
