# The gateway's image for the Cloudflare example: the runtime stage of the
# repository's Dockerfile (keep the two in sync), around a dist/ built on the
# host. Wrangler cannot pass a build secret to `docker build`, and the root
# Dockerfile's build stage needs one (GITHUB_TOKEN, for the Open OCPP Trace SDK
# on GitHub Packages), so the bundle is built beforehand: the `predev`,
# `predry-run` and `predeploy` scripts run the root `npm run build`.
# Build context: the repository root (wrangler.jsonc `image_build_context`).
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
# --ignore-scripts: skip the `prepare` (husky) lifecycle script — husky is a
# dev dependency and isn't installed here, and git hooks are irrelevant at runtime.
RUN npm ci --omit=dev --ignore-scripts
COPY dist ./dist
USER node
EXPOSE 9000
CMD ["node", "--enable-source-maps", "dist/index.cjs"]
