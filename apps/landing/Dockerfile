FROM node:22.13-alpine AS build

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/landing/package.json apps/landing/package.json

RUN corepack enable && pnpm install --frozen-lockfile

COPY apps/landing apps/landing

ARG MACHDOCH_LANDING_URL
RUN MACHDOCH_LANDING_URL="${MACHDOCH_LANDING_URL}" pnpm build:landing

FROM nginx:1.29-alpine

COPY --from=build /workspace/apps/landing/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["wget", "--quiet", "--output-document=/dev/null", "http://127.0.0.1/"]
