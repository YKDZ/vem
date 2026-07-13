# syntax=docker/dockerfile:1.7

FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM node:24-slim AS openssh-runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client \
  && rm -rf /var/lib/apt/lists/*

FROM base AS pruner
COPY package.json ./
RUN TURBO_VERSION="$(node -p 'require("./package.json").devDependencies.turbo')" \
  && npm install -g "turbo@${TURBO_VERSION}"
COPY . .
RUN turbo prune service-api --docker

FROM base AS builder
COPY --from=pruner /app/out/json/ ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  PNPM_VERSION="$(node -p 'require("./package.json").packageManager')" \
  && corepack prepare "${PNPM_VERSION}" --activate \
  && pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ ./
COPY --from=pruner /app/tsconfig.base.json ./tsconfig.base.json
RUN pnpm --filter @vem/shared build \
  && pnpm --filter @vem/db build \
  && pnpm --filter service-api build \
  && pnpm --filter service-api deploy --legacy --prod /prod/service-api

FROM openssh-runtime AS maintenance-ssh-ca-test
WORKDIR /app
COPY --from=builder /app ./
USER node
ENTRYPOINT ["node", "node_modules/tsx/dist/cli.mjs", "apps/service-api/scripts/maintenance-ssh-ca-container-entry.ts"]

FROM openssh-runtime AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /prod/service-api ./
COPY --from=builder /app/apps/service-api/dist ./dist
COPY --from=builder /app/apps/service-api/docker-entrypoint.mjs ./docker-entrypoint.mjs
USER node
EXPOSE 3000
CMD ["node", "docker-entrypoint.mjs"]
