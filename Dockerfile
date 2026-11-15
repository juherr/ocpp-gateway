# syntax=docker/dockerfile:1
# Build stage runs on the native BUILDPLATFORM (not the target arch): `vp pack`
# emits a portable JS bundle (ws stays external), so it never needs to run under
# emulation. Building once on the native arch is faster (no QEMU for the arm64
# image) and sidesteps Vite+'s native bundler binaries (Rolldown/Oxc) entirely.
FROM --platform=$BUILDPLATFORM node:26 AS build
WORKDIR /app
COPY package*.json .npmrc ./
# The Open OCPP Trace SDK comes from GitHub Packages, which needs a token even
# for a public package (.npmrc reads GITHUB_TOKEN). Passed as a build secret,
# never as an argument: `docker build --secret id=github_token,env=GITHUB_TOKEN .`
# The SDK is a dev dependency bundled into dist/, so the runtime stage below
# installs nothing from that registry and needs no token.
# --ignore-scripts: no dependency code runs while the token is mounted (in CI
# it can push images); the build needs no install script, and `prepare`
# (husky) is irrelevant here.
RUN --mount=type=secret,id=github_token,env=GITHUB_TOKEN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.web.json vite.config.mts ./
COPY src ./src
# The viewer's page, built into dist/viewer/ next to the bundle.
COPY web ./web
RUN npm run build

FROM node:26-alpine
WORKDIR /app
COPY package*.json ./
# --ignore-scripts: skip the `prepare` (husky) lifecycle script — husky is a
# dev dependency and isn't installed here, and git hooks are irrelevant at runtime.
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
USER node
EXPOSE 9000
CMD ["node", "--enable-source-maps", "dist/index.cjs"]
