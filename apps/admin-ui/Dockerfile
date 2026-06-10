# syntax=docker/dockerfile:1.7

FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS pruner
COPY package.json ./
RUN TURBO_VERSION="$(node -p 'require("./package.json").devDependencies.turbo')" \
  && npm install -g "turbo@${TURBO_VERSION}"
COPY . .
RUN turbo prune admin-ui --docker

FROM base AS builder
COPY --from=pruner /app/out/json/ ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  PNPM_VERSION="$(node -p 'require("./package.json").packageManager')" \
  && corepack prepare "${PNPM_VERSION}" --activate \
  && pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ ./
COPY --from=pruner /app/tsconfig.base.json ./tsconfig.base.json
RUN pnpm --filter @vem/shared build \
  && pnpm --filter admin-ui build

FROM nginx:alpine AS runner
COPY --from=builder /app/apps/admin-ui/dist /usr/share/nginx/html
COPY apps/admin-ui/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 80
