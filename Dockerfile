# syntax=docker/dockerfile:1

# Yarn is vendored under .yarn/releases and invoked directly, rather than fetched by corepack, so the
# build is reproducible and needs no network beyond the npm registry.
ARG YARN=.yarn/releases/yarn-4.10.3.cjs

# ---------------------------------------------------------------------------------------------
FROM node:26-alpine AS builder
ARG YARN
WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json tsconfig.json ./
COPY .yarn ./.yarn
# Every workspace manifest, because `workspaces: packages/*` means yarn resolves a different
# project when one is missing and `--immutable` then refuses the resulting lockfile change. The e2e
# package is not built or shipped, but its manifest still has to be here for the install to match.
# `dockerfile.test.ts` asserts this list stays complete.
COPY packages/e2e/package.json        packages/e2e/
COPY packages/protocol/package.json   packages/protocol/
COPY packages/server/package.json     packages/server/
COPY packages/testclient/package.json packages/testclient/
COPY packages/webui/package.json      packages/webui/
# The e2e manifest brings @playwright/test, whose install script otherwise downloads a browser that
# nothing in this image will ever run.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN node $YARN install --immutable

COPY . .
RUN node $YARN build && node $YARN workspace @satellite-mock/webui build

# ---------------------------------------------------------------------------------------------
FROM node:26-alpine AS deps
ARG YARN
WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn
COPY packages/e2e/package.json        packages/e2e/
COPY packages/protocol/package.json   packages/protocol/
COPY packages/server/package.json     packages/server/
COPY packages/testclient/package.json packages/testclient/
COPY packages/webui/package.json      packages/webui/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN node $YARN workspaces focus --production @satellite-mock/server --all

# ---------------------------------------------------------------------------------------------
FROM node:26-alpine AS runtime
WORKDIR /app

# @napi-rs/canvas ships a musl prebuild, so no toolchain is needed — but it has no fonts of its own,
# and an image with none renders every label blank. fontconfig + DejaVu is the floor; the renderer
# registers its own bundled font on top so output is identical across platforms (see design.md §6).
RUN apk add --no-cache fontconfig font-dejavu tzdata

ENV NODE_ENV=production

COPY --from=deps    --chown=node:node /app/node_modules                   ./node_modules
COPY --from=builder --chown=node:node /app/packages/protocol/dist         ./packages/protocol/dist
COPY --from=builder --chown=node:node /app/packages/protocol/package.json ./packages/protocol/
COPY --from=builder --chown=node:node /app/packages/server/dist           ./packages/server/dist
COPY --from=builder --chown=node:node /app/packages/server/package.json   ./packages/server/
COPY --from=builder --chown=node:node /app/packages/webui/dist            ./packages/webui/dist
COPY --chown=node:node package.json ./

USER node

# 16623 satellite websocket · 16624 web UI + tRPC · 16625 prometheus metrics (never published)
EXPOSE 16623 16624

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:16624/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/main.js"]
