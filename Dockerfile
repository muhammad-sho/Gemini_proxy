# ---- Build stage: compile server + dashboard ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
# better-sqlite3 v13 ships no prebuilt binaries; node-gyp needs a toolchain.
RUN apk add --no-cache python3 make g++
# Lockfile is generated with --legacy-peer-deps (peer ranges of newer Vite/React
# tooling overlap); npm must use the same mode or ci() rejects the tree.
RUN npm ci --legacy-peer-deps --no-audit --no-fund

COPY tsconfig.json eslint.config.mjs ./
COPY src ./src
COPY web ./web

RUN npm run build && npm run web:build

# Prune to production dependencies only (dist/ and dist-web/ are static outputs)
RUN npm prune --omit=dev --legacy-peer-deps

# ---- Runtime stage: minimal, drops to non-root after fixing data volume ----
FROM node:22-alpine AS runtime
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app \
    && apk add --no-cache su-exec \
    && mkdir -p /data && chown app:app /data

ENV NODE_ENV=production \
    DB_PATH=/data/gemini-proxy.db \
    PORT=18765

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/dist-web ./dist-web
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --chmod=755 entrypoint.sh ./entrypoint.sh

EXPOSE 18765

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null 2>&1 || exit 1

# Starts as root only to fix /data ownership (bind mounts), then immediately
# execs the server as the unprivileged `app` user — see entrypoint.sh.
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "dist/main.js"]
