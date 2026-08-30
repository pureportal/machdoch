FROM node:22.13-bookworm-slim AS base

WORKDIR /workspace

RUN npm install --global corepack@0.34.6 \
    && corepack enable

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/fleet-manager/package.json apps/fleet-manager/package.json
COPY packages/fleet-protocol/package.json packages/fleet-protocol/package.json
COPY packages/product-ui/package.json packages/product-ui/package.json

RUN pnpm install --frozen-lockfile

FROM dependencies AS build

COPY apps/fleet-manager apps/fleet-manager
COPY packages/fleet-protocol packages/fleet-protocol
COPY packages/product-ui packages/product-ui

RUN pnpm build:fleet-manager

FROM base AS production-dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/fleet-manager/package.json apps/fleet-manager/package.json
COPY packages/fleet-protocol/package.json packages/fleet-protocol/package.json
COPY packages/product-ui/package.json packages/product-ui/package.json

RUN pnpm install --prod --frozen-lockfile

FROM node:22.13-bookworm-slim

ENV NODE_ENV=production

WORKDIR /workspace

COPY --from=production-dependencies /workspace ./
COPY --from=build --chown=node:node /workspace/apps/fleet-manager/.next apps/fleet-manager/.next
COPY --from=build --chown=node:node /workspace/apps/fleet-manager/src apps/fleet-manager/src
COPY --from=build --chown=node:node /workspace/apps/fleet-manager/next.config.ts apps/fleet-manager/next.config.ts
COPY --from=build --chown=node:node /workspace/apps/fleet-manager/tsconfig.json apps/fleet-manager/tsconfig.json
COPY --from=build --chown=node:node /workspace/packages/fleet-protocol/src packages/fleet-protocol/src
COPY --from=build --chown=node:node /workspace/packages/product-ui/src packages/product-ui/src

RUN mkdir -p /config/data \
    && chown -R node:node /config

WORKDIR /workspace/apps/fleet-manager

RUN test -f .next/BUILD_ID \
    && test -L node_modules/@machdoch/fleet-protocol \
    && test -L node_modules/@machdoch/product-ui \
    && node --import @oxc-node/core/register --input-type=module --eval "await import('@machdoch/fleet-protocol')"

USER node

EXPOSE 43188

VOLUME ["/config/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:43188/healthz').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

ENTRYPOINT ["node", "--enable-source-maps", "--import", "@oxc-node/core/register", "src/server.ts"]
CMD ["serve", "--config", "/config/fleet-manager.json"]
