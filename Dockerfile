# syntax=docker/dockerfile:1

FROM node:26-bookworm-slim AS build
WORKDIR /app
ENV YARN_ENABLE_GLOBAL_CACHE=false
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json tsconfig.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/testclient/package.json packages/testclient/
COPY packages/webui/package.json packages/webui/
RUN yarn install --immutable
COPY . .
RUN yarn build && yarn workspace @satellite-mock/webui build

FROM node:26-bookworm-slim AS deps
WORKDIR /app
ENV YARN_ENABLE_GLOBAL_CACHE=false
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/testclient/package.json packages/testclient/
COPY packages/webui/package.json packages/webui/
RUN yarn workspaces focus --production @satellite-mock/server --all

FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Runs as the `node` user that the base image already provides, on a read-only rootfs (see
# docker-compose.yml). Nothing is written to disk at runtime — all state is in memory by design.
COPY --from=deps  --chown=node:node /app/node_modules              ./node_modules
COPY --from=build --chown=node:node /app/packages/protocol/dist    ./packages/protocol/dist
COPY --from=build --chown=node:node /app/packages/protocol/package.json ./packages/protocol/
COPY --from=build --chown=node:node /app/packages/server/dist      ./packages/server/dist
COPY --from=build --chown=node:node /app/packages/server/package.json  ./packages/server/
COPY --from=build --chown=node:node /app/packages/webui/dist       ./packages/webui/dist
USER node
EXPOSE 16623 16624
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:16624/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/dist/main.js"]
