# syntax=docker/dockerfile:1.7

FROM node:24-slim AS base
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV NPM_CONFIG_REGISTRY=$NPM_CONFIG_REGISTRY
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS pruner
ARG TURBO_VERSION=2.10.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
RUN corepack prepare "$(node -p 'require("./package.json").packageManager')" --activate
COPY . .
RUN --mount=type=cache,id=vem-pnpm,target=/pnpm/store pnpm dlx turbo@$TURBO_VERSION prune service-api --docker

FROM base AS builder
COPY --from=pruner /app/out/json/ ./
RUN corepack prepare "$(node -p 'require("./package.json").packageManager')" --activate
RUN --mount=type=cache,id=vem-pnpm,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY --from=pruner /app/out/full/ ./
COPY --from=pruner /app/tsconfig.base.json ./tsconfig.base.json
RUN --mount=type=cache,id=vem-pnpm,target=/pnpm/store pnpm install --offline --frozen-lockfile \
  && pnpm --filter @vem/shared build \
  && pnpm --filter @vem/db build \
  && pnpm --filter service-api build \
  && pnpm --filter service-api deploy --legacy --offline --prod /prod/service-api

FROM node:24-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /prod/service-api ./
COPY --from=builder /app/apps/service-api/dist ./dist
COPY --from=builder /app/apps/service-api/docker-entrypoint.mjs ./docker-entrypoint.mjs
USER node
EXPOSE 3000
CMD ["node", "docker-entrypoint.mjs"]
