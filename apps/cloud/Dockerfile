FROM node:24.22.1-bookworm-slim AS base

WORKDIR /workspace

RUN npm install --global corepack@0.34.6 \
    && corepack enable

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cloud/package.json apps/cloud/package.json
COPY apps/client/package.json apps/client/package.json
COPY packages/client-ui/package.json packages/client-ui/package.json
COPY packages/fleet-protocol/package.json packages/fleet-protocol/package.json
COPY packages/product-ui/package.json packages/product-ui/package.json
COPY packages/media-studio/package.json packages/media-studio/package.json
COPY packages/analytics/package.json packages/analytics/package.json
COPY packages/speech/package.json packages/speech/package.json
COPY packages/text-to-speech/package.json packages/text-to-speech/package.json
COPY packages/model-runtime/package.json packages/model-runtime/package.json
COPY packages/cloud-client/package.json packages/cloud-client/package.json
COPY packages/recurrence/package.json packages/recurrence/package.json

RUN pnpm install --frozen-lockfile

FROM dependencies AS build

COPY apps/cloud apps/cloud
COPY apps/client apps/client
COPY packages/client-ui packages/client-ui
COPY packages/fleet-protocol packages/fleet-protocol
COPY packages/product-ui packages/product-ui
COPY packages/media-studio packages/media-studio
COPY packages/analytics packages/analytics
COPY packages/speech packages/speech
COPY packages/text-to-speech packages/text-to-speech
COPY packages/model-runtime packages/model-runtime
COPY packages/cloud-client packages/cloud-client
COPY packages/recurrence packages/recurrence
COPY LICENSE NOTICE EULA.md THIRD_PARTY_NOTICES.md ./
COPY legal legal
COPY docs/licensing docs/licensing
COPY scripts/licensing scripts/licensing

RUN pnpm build:cloud \
    && node scripts/licensing/generate.mjs cloud

FROM base AS production-dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cloud/package.json apps/cloud/package.json
COPY packages/client-ui/package.json packages/client-ui/package.json
COPY packages/fleet-protocol/package.json packages/fleet-protocol/package.json
COPY packages/product-ui/package.json packages/product-ui/package.json
COPY packages/media-studio/package.json packages/media-studio/package.json
COPY packages/analytics/package.json packages/analytics/package.json
COPY packages/speech/package.json packages/speech/package.json
COPY packages/text-to-speech/package.json packages/text-to-speech/package.json
COPY packages/model-runtime/package.json packages/model-runtime/package.json
COPY packages/cloud-client/package.json packages/cloud-client/package.json
COPY packages/recurrence/package.json packages/recurrence/package.json

RUN pnpm install --prod --frozen-lockfile

FROM node:24.22.1-bookworm-slim AS application

ENV NODE_ENV=production
ENV MACHDOCH_CLOUD_LISTEN_ADDRESS=0.0.0.0
ENV PORT=43188

WORKDIR /workspace

COPY --from=production-dependencies /workspace ./
COPY --from=build --chown=node:node /workspace/apps/cloud/.next apps/cloud/.next
COPY --from=build --chown=node:node /workspace/apps/cloud/public apps/cloud/public
COPY --from=build --chown=node:node /workspace/apps/cloud/src apps/cloud/src
COPY --from=build --chown=node:node /workspace/apps/cloud/dist/cloud-model-worker.mjs apps/cloud/dist/cloud-model-worker.mjs
COPY --from=build --chown=node:node /workspace/apps/cloud/dist/cloud-smtp-worker.mjs apps/cloud/dist/cloud-smtp-worker.mjs
COPY --from=build --chown=node:node /workspace/apps/cloud/dist/cloud-oidc-worker.mjs apps/cloud/dist/cloud-oidc-worker.mjs
COPY --from=build --chown=node:node /workspace/apps/cloud/dist/cloud-recurrence-worker.mjs apps/cloud/dist/cloud-recurrence-worker.mjs
COPY --from=build --chown=node:node /workspace/apps/cloud/dist/cloud-workflows.cjs apps/cloud/dist/cloud-workflows.cjs
COPY --from=build --chown=node:node /workspace/apps/cloud/scripts/cloud-workflows.ts apps/cloud/scripts/cloud-workflows.ts
COPY --from=build --chown=node:node /workspace/apps/cloud/next.config.ts apps/cloud/next.config.ts
COPY --from=build --chown=node:node /workspace/apps/cloud/tsconfig.json apps/cloud/tsconfig.json
COPY --from=build --chown=node:node /workspace/packages/client-ui/src packages/client-ui/src
COPY --from=build --chown=node:node /workspace/packages/fleet-protocol/src packages/fleet-protocol/src
COPY --from=build --chown=node:node /workspace/packages/product-ui/src packages/product-ui/src
COPY --from=build --chown=node:node /workspace/packages/media-studio/src packages/media-studio/src
COPY --from=build --chown=node:node /workspace/packages/analytics/src packages/analytics/src
COPY --from=build --chown=node:node /workspace/packages/speech/src packages/speech/src
COPY --from=build --chown=node:node /workspace/packages/text-to-speech/src packages/text-to-speech/src
COPY --from=build --chown=node:node /workspace/packages/model-runtime/src packages/model-runtime/src
COPY --from=build --chown=node:node /workspace/packages/cloud-client/src packages/cloud-client/src
COPY --from=build --chown=node:node /workspace/packages/recurrence/src packages/recurrence/src
COPY --from=build /workspace/apps/cloud/dist/legal legal-release

WORKDIR /workspace/apps/cloud

RUN test -f .next/BUILD_ID \
    && test -f dist/cloud-model-worker.mjs \
    && test -f dist/cloud-smtp-worker.mjs \
    && test -f dist/cloud-oidc-worker.mjs \
    && test -f dist/cloud-recurrence-worker.mjs \
    && test -f dist/cloud-workflows.cjs \
    && test -f public/media-studio/index.html \
    && test -L node_modules/@machdoch/client-ui \
    && test -L node_modules/@machdoch/fleet-protocol \
    && test -L node_modules/@machdoch/media-studio \
    && test -L node_modules/@machdoch/product-ui \
    && test -L node_modules/@machdoch/speech \
    && test -L node_modules/@machdoch/text-to-speech \
    && test -L node_modules/@machdoch/model-runtime \
    && node --import @oxc-node/core/register --input-type=module --eval "await import('@machdoch/fleet-protocol')"

USER node

EXPOSE 43188

FROM application AS cloud-workflows

ENTRYPOINT ["node", "--enable-source-maps", "--import", "@oxc-node/core/register", "scripts/cloud-workflows.ts"]
CMD []

FROM application AS server

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:43188/healthz').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

ENTRYPOINT ["node", "--enable-source-maps", "--import", "@oxc-node/core/register", "src/server.ts"]
CMD ["serve"]
