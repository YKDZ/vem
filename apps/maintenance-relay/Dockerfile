# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS base
ARG PACKAGE_MANAGER_PIN="pnpm@11.9.0+sha512.bd682d5d03fe525ef7c9fd6780c6884d1e756ac4c9c9fe00c538782824310dcf90e3ddc4f53835f06dfaebd5085e41855e0bcbb3b60de2ac5bbab89e5036f03b"
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /repo
RUN corepack enable && corepack prepare "$PACKAGE_MANAGER_PIN" --activate

FROM base AS pruner
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY package.json turbo.json tsconfig.base.json ./
COPY apps/maintenance-relay/package.json apps/maintenance-relay/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --offline --frozen-lockfile
RUN pnpm exec turbo prune maintenance-relay --docker

FROM base AS builder
COPY --from=pruner /repo/out/json/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/out/json/pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN pnpm fetch
COPY --from=pruner /repo/out/json/ ./
RUN pnpm install --offline --frozen-lockfile
COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.lib.json packages/shared/tsconfig.spec.json packages/shared/vite.config.ts ./packages/shared/
COPY apps/maintenance-relay/src ./apps/maintenance-relay/src
COPY apps/maintenance-relay/tsconfig.json apps/maintenance-relay/tsconfig.build.json ./apps/maintenance-relay/
RUN pnpm --filter @vem/shared build \
  && pnpm --filter maintenance-relay build \
  && pnpm --filter maintenance-relay deploy --legacy --prod /prod/maintenance-relay \
  && find /prod/maintenance-relay -type d \( \
      -name src -o -name source -o -name test -o -name tests -o \
      -name __tests__ -o -name docs -o -name examples -o -name scripts -o \
      -name types -o -name benchmark -o -name benchmarks \
    \) -prune -exec rm -rf '{}' + \
  && find /prod/maintenance-relay -type f \( \
      -name '*.ts' -o -name '*.tsx' -o -name '*.cts' -o -name '*.mts' -o \
      -name '*.map' -o -name '*.tsbuildinfo' \
    \) -delete

FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    iproute2=6.1.0-3 \
    libcap2-bin=1:2.66-4+deb12u3+b1 \
    nftables=1.0.6-2+deb12u2 \
    wireguard-tools=1.0.20210914-1+b1 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 relay \
  && useradd --system --uid 1001 --gid relay --home-dir /app --shell /usr/sbin/nologin relay \
  && install -d -o 1001 -g 1001 -m 0700 /run/vem/maintenance-relay \
  && setcap cap_net_admin=eip "$(readlink -f /usr/bin/setpriv)" \
  && rm -rf \
    /root/.cache /root/.npm /tmp/* /var/cache/apt/* /var/lib/apt/lists/* \
    /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=builder --chown=1001:1001 /prod/maintenance-relay/node_modules ./node_modules
COPY --from=builder --chown=1001:1001 /repo/apps/maintenance-relay/dist ./dist
COPY --chown=1001:1001 apps/maintenance-relay/package.runtime.json ./package.json
COPY apps/maintenance-relay/docker-entrypoint.sh /usr/local/bin/maintenance-relay
COPY apps/maintenance-relay/wireguard-syncconf /usr/local/libexec/maintenance-relay-wireguard-syncconf
RUN chmod 0555 \
    /usr/local/bin/maintenance-relay \
    /usr/local/libexec/maintenance-relay-wireguard-syncconf
EXPOSE 51820/udp
USER 1001:1001
ENTRYPOINT ["/usr/bin/setpriv", "--inh-caps", "+net_admin", "--ambient-caps", "+net_admin", "--no-new-privs", "/usr/local/bin/maintenance-relay"]
